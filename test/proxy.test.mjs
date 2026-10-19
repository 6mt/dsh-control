/**
 * Unit tests for the same-origin environment proxy (lib/proxy.js).
 *
 * The proxy is the trust boundary between the local web server and the
 * remote dsh: it must inject the remote's credentials (and only those),
 * never leak the remote's Set-Cookie into the local origin, rewrite the
 * path prefix, stream bodies without buffering, and pass WebSocket
 * upgrades through.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mountEnvironmentProxy } from "../lib/proxy.js";

/** A local web-server stand-in: prefix routes + one upgrade route. */
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
// Upgraded sockets drop out of the server's connection bookkeeping, so close()
// can wait forever on them — bound it so a wedged proxy fails fast instead.
const close = (server) => Promise.race([
	new Promise((resolve) => {
		server.closeAllConnections?.();
		server.close(resolve);
	}),
	new Promise((resolve) => { setTimeout(resolve, 2_000); }),
]);
const get = (url, headers = {}) => new Promise((resolve, reject) => {
	httpRequest(url, { headers, agent: false }, (res) => {
		let body = "";
		res.on("data", (chunk) => { body += chunk; });
		res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
	}).on("error", reject).end();
});

test("forwards under the prefix: path, query, and the remote cookie only", async () => {
	const seen = {};
	const upstream = createServer((req, res) => {
		seen.path = req.url;
		seen.cookie = req.headers.cookie;
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("ok");
	});
	const upstreamPort = await listen(upstream);
	const web = fakeWebServer();
	const mount = mountEnvironmentProxy(web, "cn", () => ({
		endpoint: `http://127.0.0.1:${upstreamPort}`,
		cookieName: "dsh-auth-remote",
		cookie: "secret",
		ensureCookie: async () => true,
	}));
	const webPort = await listen(web.server);
	try {
		const answer = await get(`http://127.0.0.1:${webPort}${mount.prefix}/api/session/list?x=1`, {
			cookie: "dsh-auth-LOCAL=should-not-leak",
		});
		assert.equal(answer.status, 200);
		assert.equal(answer.body, "ok");
		assert.equal(seen.path, "/api/session/list?x=1");
		assert.equal(seen.cookie, "dsh-auth-remote=secret");
	} finally {
		await close(web.server);
		await close(upstream);
	}
});

test("does not re-mint the cookie on every request (one round trip is enough)", async () => {
	// Re-minting per request doubled every asset fetch through the tunnel.
	const hits = [];
	const upstream = createServer((req, res) => {
		hits.push(req.url);
		res.writeHead(200, { "content-type": "application/javascript" });
		res.end("export const x = 1;");
	});
	const upstreamPort = await listen(upstream);
	const web = fakeWebServer();
	let ensureCalls = 0;
	const client = {
		endpoint: `http://127.0.0.1:${upstreamPort}`,
		cookieName: "dsh-auth-1", cookie: "abc",
		ensureCookie: async () => { ensureCalls += 1; return true; },
	};
	const mount = mountEnvironmentProxy(web, "cn", () => client);
	const webPort = await listen(web.server);
	try {
		for (let i = 0; i < 3; i += 1) await get(`http://127.0.0.1:${webPort}${mount.prefix}/assets/a-${i}.js`);
		assert.ok(ensureCalls <= 1, `at most one refresh for three requests, got ${ensureCalls}`);
	} finally {
		await close(web.server);
		await close(upstream);
	}
});

test("hashed assets are served from memory on the second request", async () => {
	let upstreamHits = 0;
	const upstream = createServer((req, res) => {
		upstreamHits += 1;
		res.writeHead(200, { "content-type": "application/javascript" });
		res.end("export const big = \"" + "x".repeat(2048) + "\";");
	});
	const upstreamPort = await listen(upstream);
	const web = fakeWebServer();
	const mount = mountEnvironmentProxy(web, "cn", () => ({
		endpoint: `http://127.0.0.1:${upstreamPort}`, cookieName: "c", cookie: "v",
		ensureCookie: async () => true,
	}));
	const webPort = await listen(web.server);
	try {
		const url = `http://127.0.0.1:${webPort}${mount.prefix}/assets/index-abc.js`;
		const first = await get(url);
		const second = await get(url);
		assert.equal(upstreamHits, 1, "second request must not touch the remote");
		assert.equal(first.body, second.body);
		assert.match(second.headers["cache-control"] ?? "", /immutable/);
	} finally {
		await close(web.server);
		await close(upstream);
	}
});

test("a 401 from the remote refreshes the cookie once and retries", async () => {
	let calls = 0;
	let accepted = "c=stale";
	const upstream = createServer((req, res) => {
		calls += 1;
		if (req.headers.cookie === accepted) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{\"ok\":true}");
			return;
		}
		res.writeHead(401, { "content-type": "application/json" });
		res.end("{\"error\":\"auth required\"}");
	});
	const upstreamPort = await listen(upstream);
	const web = fakeWebServer();
	const client = {
		endpoint: `http://127.0.0.1:${upstreamPort}`, cookieName: "c", cookie: "stale",
		ensureCookie: async () => { client.cookie = "fresh"; return true; },
	};
	const mount = mountEnvironmentProxy(web, "cn", () => client);
	const webPort = await listen(web.server);
	try {
		await get(`http://127.0.0.1:${webPort}${mount.prefix}/api/session/list`);
		// The remote rotates its cookie: the next call gets 401, we refresh and retry.
		accepted = "c=fresh";
		const answer = await get(`http://127.0.0.1:${webPort}${mount.prefix}/api/session/list`);
		assert.equal(answer.status, 200, "retried with the refreshed cookie");
		assert.equal(calls, 3, "one ok, one rejected, one ok after refresh");
	} finally {
		await close(web.server);
		await close(upstream);
	}
});

test("strips the remote's Set-Cookie from responses", async () => {
	const upstream = createServer((req, res) => {
		res.writeHead(200, { "set-cookie": "dsh-auth-remote=evil; Path=/", "content-type": "text/plain" });
		res.end("body");
	});
	const upstreamPort = await listen(upstream);
	const web = fakeWebServer();
	const mount = mountEnvironmentProxy(web, "cn", () => ({
		endpoint: `http://127.0.0.1:${upstreamPort}`,
		cookieName: "dsh-auth-remote",
		cookie: "secret",
		ensureCookie: async () => true,
	}));
	const webPort = await listen(web.server);
	try {
		const answer = await get(`http://127.0.0.1:${webPort}${mount.prefix}/`);
		assert.equal(answer.status, 200);
		assert.equal(answer.headers["set-cookie"], undefined, "remote cookies must never reach the local origin");
	} finally {
		await close(web.server);
		await close(upstream);
	}
});

test("streams bodies chunk by chunk (no buffering)", async () => {
	const upstream = createServer((req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write("data: first\n\n");
		setTimeout(() => { res.write("data: second\n\n"); res.end(); }, 120);
	});
	const upstreamPort = await listen(upstream);
	const web = fakeWebServer();
	const mount = mountEnvironmentProxy(web, "cn", () => ({
		endpoint: `http://127.0.0.1:${upstreamPort}`,
		cookieName: "dsh-auth-remote",
		cookie: "secret",
		ensureCookie: async () => true,
	}));
	const webPort = await listen(web.server);
	try {
		const chunks = [];
		await new Promise((resolve, reject) => {
			const res = httpRequest(`http://127.0.0.1:${webPort}${mount.prefix}/plugins/events`, { agent: false }, (r) => {
				r.on("data", (chunk) => { chunks.push(String(chunk)); });
				r.on("end", resolve);
				r.on("error", reject);
			});
			res.on("error", reject);
			res.end();
		});
		assert.equal(chunks.join(""), "data: first\n\ndata: second\n\n");
		assert.equal(chunks.length, 2, "two separate chunk deliveries");
	} finally {
		await close(web.server);
		await close(upstream);
	}
});

test("rewrites Origin/Referer to the upstream authority (the remote's CSRF fence demands it)", async () => {
	const seen = {};
	const upstream = createServer((req, res) => {
		seen.origin = req.headers.origin;
		seen.referer = req.headers.referer;
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("ok");
	});
	const upstreamPort = await listen(upstream);
	const web = fakeWebServer();
	const mount = mountEnvironmentProxy(web, "cn", () => ({
		endpoint: `http://127.0.0.1:${upstreamPort}`,
		cookieName: "dsh-auth-remote",
		cookie: "secret",
		ensureCookie: async () => true,
	}));
	const webPort = await listen(web.server);
	try {
		const answer = await get(`http://127.0.0.1:${webPort}${mount.prefix}/api/session/list`, {
			origin: `http://127.0.0.1:${webPort}`,
			referer: `http://127.0.0.1:${webPort}/dsh-control/env/cn/t/`,
		});
		assert.equal(answer.status, 200);
		// The remote only accepts requests whose Origin matches its own Host; after
		// the tunnel rewrite that must be the upstream authority, never the browser's.
		assert.equal(seen.origin, `http://127.0.0.1:${upstreamPort}`);
		assert.equal(seen.referer, `http://127.0.0.1:${upstreamPort}/`);
	} finally {
		await close(web.server);
		await close(upstream);
	}
});

test("passes WebSocket upgrades through with the remote cookie", async () => {
	const seen = {};
	let upstreamSocket;
	const upstream = createServer();
	upstream.on("upgrade", (req, socket) => {
		seen.path = req.url;
		seen.cookie = req.headers.cookie;
		upstreamSocket = socket;
		socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fixed\r\n\r\n");
		socket.write("proxied-payload");
	});
	const upstreamPort = await listen(upstream);
	const web = fakeWebServer();
	const mount = mountEnvironmentProxy(web, "cn", () => ({
		endpoint: `http://127.0.0.1:${upstreamPort}`,
		cookieName: "dsh-auth-remote",
		cookie: "secret",
		ensureCookie: async () => true,
	}));
	const webPort = await listen(web.server);
	try {
		const payload = await Promise.race([
			new Promise((resolve, reject) => {
				const res = httpRequest({
					host: "127.0.0.1", port: webPort, path: `${mount.prefix}/api/remote.mux`,
					headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "k", "sec-websocket-version": "13" },
					agent: false,
				});
				res.on("upgrade", (response, socket, head) => {
					// Bytes that arrived together with the 101 come detached in `head`;
					// anything later needs the socket resumed (it is paused after the event).
					const early = String(head ?? "");
					socket.resume();
					if (early !== "") { resolve({ status: response.statusCode, body: early }); socket.destroy(); return; }
					socket.on("data", (chunk) => { resolve({ status: response.statusCode, body: String(chunk) }); socket.destroy(); });
				});
				res.on("error", reject);
				res.end();
			}),
			new Promise((_, reject) => { setTimeout(() => reject(new Error("upgrade timed out")), 3_000); }),
		]);
		assert.equal(payload.status, 101);
		assert.equal(payload.body, "proxied-payload");
		assert.equal(seen.path, "/api/remote.mux");
		assert.equal(seen.cookie, "dsh-auth-remote=secret");
	} finally {
		upstreamSocket?.destroy();
		await close(web.server);
		await close(upstream);
	}
});
