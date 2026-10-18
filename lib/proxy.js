/**
 * Same-origin reverse proxy for remote dsh environments.
 *
 * Why: the remote dsh GUI must render inside the app with zero browser-auth
 * friction. Loading the tunnel port directly in an iframe dies on cookie
 * policy (SameSite/third-party), and the remote may sit behind auth shells a
 * browser cannot pass inside an iframe. Serving the GUI from the local app's
 * own origin removes both: the browser talks only to the local web server,
 * and this proxy carries the remote's credentials server-side.
 *
 * Feasibility rests on one verified fact: every URL the dsh web client builds
 * (RPC fetches, the stream mux WebSocket, the plugins SSE) is RELATIVE to the
 * document base, so a path prefix forwards everything without rewriting.
 *
 * Security posture: the mount path carries an unguessable per-process ticket
 * (`/dsh-control/env/<name>/<ticket>/...`), so other local processes cannot
 * reach the remote through us. Remote Set-Cookie headers are stripped: the
 * remote's cookies must never land in the local origin's jar.
 */
import { request } from "node:http";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { appendFileSync, statSync, truncateSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_MAX_BYTES = 256 * 1024;

/**
 * Append one diagnostic line for a proxied request. Never records cookies,
 * tokens or bodies — only what is needed to tell a broken hop from a working
 * one when a user reports "it keeps reconnecting".
 */
function logLine(entry) {
	try {
		const dir = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "dsh-control");
		const file = join(dir, "proxy.log");
		try {
			if (statSync(file).size > LOG_MAX_BYTES) truncateSync(file, 0);
		} catch { /* first write */ }
		appendFileSync(file, `${new Date().toISOString()} ${entry}\n`);
	} catch { /* diagnostics must never break the proxy */ }
}

/** Headers never forwarded in either direction. */
const HOP_BY_HOP = new Set([
	"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
	"te", "trailer", "transfer-encoding", "upgrade", "host",
]);

/** Strip hop-by-hop (and optionally set-cookie) headers. */
function forwardableHeaders(headers, { dropSetCookie = false } = {}) {
	const out = {};
	for (const [name, value] of Object.entries(headers)) {
		const lower = name.toLowerCase();
		if (HOP_BY_HOP.has(lower)) continue;
		if (dropSetCookie && lower === "set-cookie") continue;
		if (value !== undefined) out[name] = value;
	}
	return out;
}

/**
 * Mount one environment's proxy surface on a web-server-like object
 * (`register` / `registerUpgrade`, matching dsh's webServer service).
 *
 * @param server - the web server service (duck-typed for tests).
 * @param name - environment name (also the URL segment).
 * @param getClient - () => {endpoint, cookieName, cookie, authHeader} fetched
 *   per request so credential refreshes flow through.
 * @returns {{prefix: string, dispose: () => void}}
 */
export function mountEnvironmentProxy(server, name, getClient) {
	const ticket = randomUUID().replaceAll("-", "").slice(0, 22);
	const prefix = `/dsh-control/env/${encodeURIComponent(name)}/${ticket}`;

	const upstreamPort = () => {
		const client = getClient();
		return Number(new URL(client.endpoint).port);
	};

	const proxyRequest = (req, res) => {
		// Diagnostic sink used by the injected frame script (and only it).
		if (req.url.slice(prefix.length) === "/__diag") {
			const chunks = [];
			req.on("data", (c) => { chunks.push(c); });
			req.on("end", () => {
				logLine(`FRAME-DIAG ${Buffer.concat(chunks).toString("utf8").slice(0, 600)}`);
				res.writeHead(204).end();
			});
			return;
		}
		Promise.resolve()
			.then(async () => {
				const client = getClient();
				if (typeof client.ensureCookie === "function") {
					await client.ensureCookie().catch(() => false);
				}
				const headers = forwardableHeaders(req.headers);
				headers.host = `127.0.0.1:${upstreamPort()}`;
				// Ask upstream for uncompressed bytes: the HTML is instrumented below,
				// which needs text, and the local hop never pays for compression.
				headers["accept-encoding"] = "identity";
				// The remote's credentials replace whatever the browser sent.
				const cookies = [];
				if (client.cookieName !== undefined && client.cookie !== undefined) {
					cookies.push(`${client.cookieName}=${client.cookie}`);
				}
				if (client.authHeader !== undefined) headers.authorization = client.authHeader;
				if (cookies.length > 0) headers.cookie = cookies.join("; ");

				// The remote rejects (403) any request whose Origin does not match
				// its own Host — a CSRF fence. Through the tunnel the remote sees
				// 127.0.0.1:<tunnelPort>, so rewrite the browser's origin/referer to
				// that authority: the request then *is* same-origin from its view.
				const upstreamOrigin = `http://127.0.0.1:${upstreamPort()}`;
				if (headers.origin !== undefined) headers.origin = upstreamOrigin;
				if (headers.referer !== undefined) headers.referer = `${upstreamOrigin}/`;

				const sub = req.url.slice(prefix.length) || "/";
				const upstream = request(
					{ host: "127.0.0.1", port: upstreamPort(), path: sub, method: req.method, headers },
					(remote) => {
						if (res.writableEnded || res.destroyed) { remote.resume(); return; }
						logLine(`${req.method} ${sub.split("?")[0]} -> ${remote.statusCode}`);
						const headers = forwardableHeaders(remote.headers, { dropSetCookie: true });
						const type = String(remote.headers["content-type"] ?? "");
						// Instrument the document we hand the frame: report what the remote
						// client sees (transport/baseURI) and probe the stream mux, so a
						// user-side failure names itself instead of looping silently.
						if (type.includes("text/html")) {
							const chunks = [];
							remote.on("data", (c) => chunks.push(c));
							remote.on("end", () => {
								let html = Buffer.concat(chunks).toString("utf8");
								const localAuthority = String(req.headers.host ?? `127.0.0.1:${upstreamPort()}`);
								// Trailing slash is mandatory: relative resolution against a
								// slash-less base drops the last path segment (the ticket).
								const base = `http://${localAuthority}${prefix}/`;
								const script = `<script>(function(){try{var t=globalThis.__DSH_TRANSPORT__||(globalThis.__DSH_TRANSPORT__={});t.streamBaseUrl=${JSON.stringify(base)};var d=${JSON.stringify(`${prefix}/__diag`)};function r(o){try{return fetch(d,{method:"POST",body:JSON.stringify(o)}).catch(function(){})}catch(e){}}r({kind:"frame",baseURI:document.baseURI,transport:JSON.stringify(t)});var w=new WebSocket(${JSON.stringify(`${base}api/remote.mux`.replace(/^http/, "ws"))});w.onopen=function(){r({kind:"frame-ws",outcome:"open"})};w.onerror=function(){r({kind:"frame-ws",outcome:"error"})};setTimeout(function(){r({kind:"frame-ws",outcome:"timeout"})},4000)}catch(e){r({kind:"frame-error",message:String(e)})}})()</script>`;
								html = html.replace(/<head[^>]*>/i, (m) => `${m}${script}`);
								const body = Buffer.from(html, "utf8");
								delete headers["content-length"];
								delete headers["content-encoding"];
								res.writeHead(remote.statusCode ?? 200, headers);
								res.end(body);
							});
							remote.on("error", () => { try { res.destroy(); } catch { /* gone */ } });
							return;
						}
						res.writeHead(remote.statusCode ?? 502, headers);
						remote.pipe(res);
					},
				);
				upstream.on("error", (error) => {
					logLine(`${req.method} ${sub.split("?")[0]} -> UPSTREAM ERROR ${error.message}`);
					if (res.writableEnded || res.destroyed) return;
					res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
					res.end(`dsh-control 代理无法连接远端：${error.message}`);
				});
				req.pipe(upstream);
			})
			.catch((error) => {
				if (res.writableEnded || res.destroyed) return;
				res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
				res.end(`dsh-control 代理内部错误：${error.message}`);
			});
	};

	const proxyUpgrade = (req, socket, head) => {
		const client = getClient();
		const port = upstreamPort();
		const sub = req.url.slice(prefix.length) || "/";
		const headers = forwardableHeaders(req.headers);
		headers.host = `127.0.0.1:${port}`;
		// The upgrade markers are hop-by-hop by definition, but they are exactly
		// what makes this an upgrade: carry them across explicitly.
		headers.connection = "Upgrade";
		if (typeof req.headers.upgrade === "string") headers.upgrade = req.headers.upgrade;
		// Same CSRF fence applies to the handshake (browsers send Origin here too).
		const upstreamOrigin = `http://127.0.0.1:${port}`;
		if (headers.origin !== undefined) headers.origin = upstreamOrigin;
		if (headers.referer !== undefined) headers.referer = `${upstreamOrigin}/`;
		if (client.cookieName !== undefined && client.cookie !== undefined) {
			headers.cookie = `${client.cookieName}=${client.cookie}`;
		}
		if (client.authHeader !== undefined) headers.authorization = client.authHeader;
		const lines = [
			`${req.method} ${sub} HTTP/1.1`,
			...Object.entries(headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`),
			"",
			"",
		].join("\r\n");

		logLine(`UPGRADE ${sub} (origin=${String(req.headers.origin ?? "-")} host=${String(req.headers.host ?? "-")})`);
		const upstream = createConnection({ host: "127.0.0.1", port }, () => {
			upstream.write(lines);
			if (head !== undefined && head.length > 0) upstream.write(head);
			socket.pipe(upstream);
			upstream.pipe(socket);
		});
		const teardown = () => { logLine(`UPGRADE ${sub} closed`); upstream.destroy(); socket.destroy(); };
		upstream.on("error", teardown);
		socket.on("error", teardown);
		socket.on("close", () => upstream.destroy());
		upstream.on("close", () => socket.destroy());
	};

	const disposers = [
		server.register({ kind: "prefix", path: prefix, handler: proxyRequest }),
		server.registerUpgrade({ path: `${prefix}/api/remote.mux`, handler: proxyUpgrade }),
	];
	return {
		prefix,
		dispose: () => { for (const dispose of disposers) dispose(); },
	};
}
