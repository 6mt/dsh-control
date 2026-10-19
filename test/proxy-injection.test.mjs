/**
 * Regression tests for the proxy's document instrumentation and the rules
 * discovered while debugging the desktop shell's custom-scheme deployment.
 *
 * Each test here pins one failure that actually happened:
 *  - gzip upstream broke the injected HTML (must request `identity`);
 *  - the injected `streamBaseUrl` must end with "/" (a slash-less base makes
 *    relative resolution drop the ticket segment, pointing the stream mux at
 *    `…/env/<name>/api/remote.mux` — a path the proxy does not own);
 *  - the diagnostic sink must be handled locally, never forwarded upstream;
 *  - the WebSocket handshake must carry the rewritten Origin (the remote's
 *    CSRF fence rejects any request whose Origin ≠ its Host).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mountEnvironmentProxy } from "../lib/proxy.js";

function fakeWebServer() {
	const routes = [];
	const upgrades = [];
	const server = createServer((req, res) => {
		for (const route of routes) {
			if (req.url.startsWith(route.path)) { route.handler(req, res); return; }
		}
		res.writeHead(404).end();
	});
	server.on("upgrade", (req, socket, head) => {
		for (const route of upgrades) {
			if (req.url.split("?")[0] === route.path) { route.handler(req, socket, head); return; }
		}
		socket.destroy();
	});
	return {
		server,
		register: (route) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1); }; },
		registerUpgrade: (route) => { upgrades.push(route); return () => { upgrades.splice(upgrades.indexOf(route), 1); }; },
	};
}

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => Promise.race([
	new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
	new Promise((resolve) => { setTimeout(resolve, 2_000); }),
]);
const get = (url, headers = {}) => new Promise((resolve, reject) => {
	httpRequest(url, { headers, agent: false }, (res) => {
		let body = "";
		res.on("data", (chunk) => { body += chunk; });
		res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
	}).on("error", reject).end();
});
const post = (url, body) => new Promise((resolve, reject) => {
	const req = httpRequest(url, { method: "POST", agent: false }, (res) => {
		let text = "";
		res.on("data", (chunk) => { text += chunk; });
		res.on("end", () => resolve({ status: res.statusCode, body: text }));
	});
	req.on("error", reject);
	req.end(body);
});

test("asks upstream for identity encoding (instrumentation needs text)", async () => {
	const seen = {};
	const upstream = createServer((req, res) => {
		seen.acceptEncoding = req.headers["accept-encoding"];
		res.writeHead(200, { "content-type": "text/html" });
		res.end("<html><head></head><body>ok</body></html>");
	});
	const upstreamPort = await listen(upstream);
	const web = fakeWebServer();
	const mount = mountEnvironmentProxy(web, "cn", () => ({
		endpoint: `http://127.0.0.1:${upstreamPort}`, cookieName: "c", cookie: "v",
		ensureCookie: async () => true,
	}));
	const webPort = await listen(web.server);
	try {
		// A document navigation asks for identity (the HTML gets instrumented)…
		await get(`http://127.0.0.1:${webPort}${mount.prefix}/`, {
			"accept-encoding": "gzip, br", accept: "text/html,application/xhtml+xml",
		});
		assert.equal(seen.acceptEncoding, "identity");
		// …as are hashed assets (they get cached locally, so plain bytes)…
		await get(`http://127.0.0.1:${webPort}${mount.prefix}/assets/index-abc.js`, {
			"accept-encoding": "gzip, br", accept: "*/*",
		});
		assert.equal(seen.acceptEncoding, "identity", "assets are cached, so no compression");
		// …while an API call keeps the browser's compression offer.
		await get(`http://127.0.0.1:${webPort}${mount.prefix}/api/session/list`, {
			"accept-encoding": "gzip, br", accept: "application/json",
		});
		assert.equal(seen.acceptEncoding, "gzip, br");
	} finally {
		await close(web.server);
		await close(upstream);
	}
});

test("instrumented HTML carries a slash-terminated streamBaseUrl and a valid diag path", async () => {
	const upstream = createServer((req, res) => {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end("<html><head><title>t</title></head><body>x</body></html>");
	});
	const upstreamPort = await listen(upstream);
	const web = fakeWebServer();
	const mount = mountEnvironmentProxy(web, "cn", () => ({
		endpoint: `http://127.0.0.1:${upstreamPort}`, cookieName: "c", cookie: "v",
		ensureCookie: async () => true,
	}));
	const webPort = await listen(web.server);
	try {
		const answer = await get(`http://127.0.0.1:${webPort}${mount.prefix}/`);
		assert.equal(answer.status, 200);
		assert.match(answer.body, /__DSH_TRANSPORT__/, "transport injection present");
		// The injected base must end with "/" — otherwise `new URL("api/remote.mux", base)`
		// drops the last segment (the ticket) and the mux path stops matching.
		const match = answer.body.match(/var BASE="([^"]*)"/);
		assert.ok(match !== null, "streamBaseUrl injected");
		assert.ok(match[1].endsWith("/"), `streamBaseUrl must end with "/" (got ${match[1]})`);
		assert.ok(match[1].includes(mount.prefix), "streamBaseUrl carries the ticket prefix");
		// Diagnostic sink path must include the separator (a missing slash 405'd).
		assert.match(answer.body, new RegExp(`${mount.prefix}/__diag`), "diag path has the separator");
	} finally {
		await close(web.server);
		await close(upstream);
	}
});

test("injected streamBaseUrl uses the host-supplied authority, not the request Host", async () => {
	// In the desktop app the frame is served through the shell's custom scheme;
	// its requests reach us with a rewritten Host ("app"), which is NOT a real
	// authority. The socket base must therefore come from what the host knows.
	const upstream = createServer((req, res) => {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end("<html><head></head><body>x</body></html>");
	});
	const upstreamPort = await listen(upstream);
	const web = fakeWebServer();
	const mount = mountEnvironmentProxy(web, "cn", () => ({
		endpoint: `http://127.0.0.1:${upstreamPort}`, cookieName: "c", cookie: "v",
		ensureCookie: async () => true,
	}), { authority: "127.0.0.1:65000" });
	const webPort = await listen(web.server);
	try {
		const answer = await get(`http://127.0.0.1:${webPort}${mount.prefix}/`, { host: "app" });
		const match = answer.body.match(/var BASE="([^"]*)"/);
		assert.ok(match !== null, "base injected");
		assert.equal(match[1], `http://127.0.0.1:65000${mount.prefix}/`);
		// The shell may assign __DSH_TRANSPORT__ later; our base must survive it.
		assert.match(answer.body, /defineProperty\(globalThis,"__DSH_TRANSPORT__"/, "transport assignment is guarded");
	} finally {
		await close(web.server);
		await close(upstream);
	}
});

test("the diagnostic sink answers locally and is never forwarded upstream", async () => {
	let upstreamHits = 0;
	const upstream = createServer((req, res) => {
		upstreamHits += 1;
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("upstream");
	});
	const upstreamPort = await listen(upstream);
	const web = fakeWebServer();
	const mount = mountEnvironmentProxy(web, "cn", () => ({
		endpoint: `http://127.0.0.1:${upstreamPort}`, cookieName: "c", cookie: "v",
		ensureCookie: async () => true,
	}));
	const webPort = await listen(web.server);
	try {
		const answer = await post(`http://127.0.0.1:${webPort}${mount.prefix}/__diag`, JSON.stringify({ kind: "test" }));
		assert.equal(answer.status, 204);
		assert.equal(upstreamHits, 0, "diagnostics must not leak to the remote");
	} finally {
		await close(web.server);
		await close(upstream);
	}
});

test("the WebSocket handshake carries the rewritten Origin", async () => {
	const seen = {};
	let upstreamSocket;
	const upstream = createServer();
	upstream.on("upgrade", (req, socket) => {
		seen.origin = req.headers.origin;
		upstreamSocket = socket;
		socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fixed\r\n\r\n");
	});
	const upstreamPort = await listen(upstream);
	const web = fakeWebServer();
	const mount = mountEnvironmentProxy(web, "cn", () => ({
		endpoint: `http://127.0.0.1:${upstreamPort}`, cookieName: "c", cookie: "v",
		ensureCookie: async () => true,
	}));
	const webPort = await listen(web.server);
	try {
		await Promise.race([
			new Promise((resolve, reject) => {
				const res = httpRequest({
					host: "127.0.0.1", port: webPort, path: `${mount.prefix}/api/remote.mux`,
					headers: {
						connection: "Upgrade", upgrade: "websocket",
						"sec-websocket-key": "k", "sec-websocket-version": "13",
						origin: `http://127.0.0.1:${webPort}`,
					},
					agent: false,
				});
				res.on("upgrade", (response, socket) => { socket.resume(); resolve(response.statusCode); socket.destroy(); });
				res.on("error", reject);
				res.end();
			}),
			new Promise((_, reject) => { setTimeout(() => reject(new Error("upgrade timed out")), 3_000); }),
		]);
		assert.equal(seen.origin, `http://127.0.0.1:${upstreamPort}`, "handshake origin must match upstream authority");
	} finally {
		upstreamSocket?.destroy();
		await close(web.server);
		await close(upstream);
	}
});
