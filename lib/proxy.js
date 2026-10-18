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
		Promise.resolve()
			.then(async () => {
				const client = getClient();
				if (typeof client.ensureCookie === "function") {
					await client.ensureCookie().catch(() => false);
				}
				const headers = forwardableHeaders(req.headers);
				headers.host = `127.0.0.1:${upstreamPort()}`;
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
						res.writeHead(remote.statusCode ?? 502, forwardableHeaders(remote.headers, { dropSetCookie: true }));
						remote.pipe(res);
					},
				);
				upstream.on("error", (error) => {
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

		const upstream = createConnection({ host: "127.0.0.1", port }, () => {
			upstream.write(lines);
			if (head !== undefined && head.length > 0) upstream.write(head);
			socket.pipe(upstream);
			upstream.pipe(socket);
		});
		const teardown = () => { upstream.destroy(); socket.destroy(); };
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
