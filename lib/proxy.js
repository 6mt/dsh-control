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
import { appendFileSync, mkdirSync, statSync, truncateSync } from "node:fs";
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
		// The directory normally exists (state lives there), but a fresh home or
		// a scratch test home must not silently swallow every diagnostic line.
		mkdirSync(dir, { recursive: true });
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
const AUTH_TTL_MS = 5 * 60_000;
const ASSET_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Hashed front-end assets are immutable: the remote only serves names it
 * referenced from the current document. Caching them locally is what makes
 * reopening a remote environment after a sleep fast — otherwise every reopen
 * re-pulls the whole UI through the tunnel.
 */
const isCacheableAsset = (req, sub) =>
	req.method === "GET" && sub.startsWith("/assets/") && !sub.includes("..");

export function mountEnvironmentProxy(server, name, getClient, options = {}) {
	const ticket = randomUUID().replaceAll("-", "").slice(0, 22);
	const prefix = `/dsh-control/env/${encodeURIComponent(name)}/${ticket}`;

	const upstreamPort = () => {
		const client = getClient();
		return Number(new URL(client.endpoint).port);
	};

	// Auth is proven by a successful upstream response; re-minting a cookie on
	// every single request doubles the round trips through the tunnel.
	let authVerifiedAt = 0;
	const assets = new Map();
	let assetBytes = 0;

	const cacheAsset = (key, body, headers) => {
		if (body.length > 8 * 1024 * 1024) return;
		if (assetBytes + body.length > ASSET_CACHE_MAX_BYTES) {
			for (const [oldKey, entry] of assets) {
				assets.delete(oldKey);
				assetBytes -= entry.body.length;
				if (assetBytes + body.length <= ASSET_CACHE_MAX_BYTES) break;
			}
		}
		assets.set(key, { body, headers });
		assetBytes += body.length;
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
				const sub = req.url.slice(prefix.length) || "/";

				// Serve hashed assets from memory — the browser still asks after a
				// sleep, and a local hit costs nothing.
				if (isCacheableAsset(req, sub)) {
					const hit = assets.get(sub);
					if (hit !== undefined) {
						logLine(`GET ${sub.split("?")[0]} -> 200 (cached)`);
						const headers = { ...hit.headers, "cache-control": "private, max-age=31536000, immutable" };
						res.writeHead(200, headers);
						res.end(hit.body);
						return;
					}
				}

				if (typeof client.ensureCookie === "function" && (client.cookie === undefined || Date.now() - authVerifiedAt > AUTH_TTL_MS)) {
					const fresh = await client.ensureCookie().catch(() => false);
					if (fresh === true) authVerifiedAt = Date.now();
				}
				const headers = forwardableHeaders(req.headers);
				headers.host = `127.0.0.1:${upstreamPort()}`;
				// Only the document is buffered for instrumentation, so only the
				// document needs identity encoding. Bundles keep the browser's gzip
				// offer: they are ~14 MB uncompressed and dominate the load time.
				const documentRequest = String(req.headers.accept ?? "").toLowerCase().includes("text/html");
				const cacheable = isCacheableAsset(req, sub);
				// The document is instrumented and assets are cached, so both need
				// plain bytes; everything else keeps the browser's compression offer.
				if (documentRequest || cacheable) headers["accept-encoding"] = "identity";
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

				const send = async (retried) => {
					const upstream = request(
						{ host: "127.0.0.1", port: upstreamPort(), path: sub, method: req.method, headers },
						async (remote) => {
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
									// The frame is same-scheme with the desktop shell (so the shell's
									// WebSocket policy treats it like its own page), while the stream
									// mux must go to a REAL http authority — the shell's custom
									// scheme has no hostname a socket could reach. The authority is
									// supplied by the host (it knows the listening port); the request
									// Host is not usable here because the protocol handler rewrites it.
									// Trailing slash is mandatory: a slash-less base drops the ticket.
									const authority = options.authority ?? String(req.headers.host ?? `127.0.0.1:${upstreamPort()}`);
									const base = `http://${authority}${prefix}/`;
									const script = `<script>(function(){
	try{
	var BASE=${JSON.stringify(base)};
	var DIAG=${JSON.stringify(`${prefix}/__diag`)};
var PATCH={fetch:false,xhr:false,es:false,ws:false,beacon:false};
	function report(o){try{return fetch(DIAG,{method:"POST",body:JSON.stringify(o)}).catch(function(){})}catch(e){}}
	var t=globalThis.__DSH_TRANSPORT__||{};
	t.streamBaseUrl=BASE;
	try{
	Object.defineProperty(globalThis,"__DSH_TRANSPORT__",{configurable:true,enumerable:true,
	get:function(){return t},
	set:function(v){t=Object.assign({},v,{streamBaseUrl:BASE})}});
	}catch(e){globalThis.__DSH_TRANSPORT__=t}
	// Same-origin means an absolute "/api/…" (or "/sidebar/api/…") request from the
// remote UI would hit the LOCAL app instead of the remote. Route every
// same-origin absolute request back through this mount's prefix.
(function(){
var PREFIX=${JSON.stringify(`${prefix}/`)};
function toProxy(input){
try{
var url=new URL(String(input),document.baseURI);
var proto=url.protocol;if((proto!=="http:"&&proto!=="https:"&&proto!=="ws:"&&proto!=="wss:")||url.host!==location.host)return String(input);
if(url.pathname.indexOf(PREFIX)===0)return String(input);
var p=url.pathname;url.pathname=PREFIX+(p.charAt(0)==="/"?p.slice(1):p);
return url.href;
}catch(e){return String(input)}
}
var of=window.fetch;
// The desktop preload may expose fetch as a getter-only accessor on dsh-app
// pages; a plain assignment then silently fails and absolute URLs keep hitting
// the local app. Try defineProperty first, fall back to assignment, and record
// the outcome so the startup diagnostic shows what actually stuck.
var wf=function(input,init){
try{
if(typeof input==="string"||input instanceof URL)return of.call(this,toProxy(input),init);
if(input&&typeof input==="object"&&input.url)return of.call(this,new Request(toProxy(input.url),input),init);
}catch(e){}
return of.call(this,input,init);
};
if(of){
try{Object.defineProperty(window,"fetch",{value:wf,writable:true,configurable:true});PATCH.fetch=true}
catch(e){try{window.fetch=wf;PATCH.fetch=(window.fetch===wf)}catch(e2){}}
}
var ox=XMLHttpRequest.prototype.open;
try{
XMLHttpRequest.prototype.open=function(method,url){
if(arguments.length>1)arguments[1]=toProxy(url);
return ox.apply(this,arguments);
};
PATCH.xhr=true;
}catch(e){}
var oes=window.EventSource;
if(oes){var ES=function(url,cfg){return cfg===undefined?new oes(toProxy(url)):new oes(toProxy(url),cfg)};ES.prototype=oes.prototype;
try{Object.defineProperty(window,"EventSource",{value:ES,writable:true,configurable:true});PATCH.es=true}
catch(e){try{window.EventSource=ES;PATCH.es=(window.EventSource===ES)}catch(e2){}}}
var ows=window.WebSocket;
if(ows){
var WS=function(url,protocols){
var target=toProxy(url);
var sock=protocols===undefined?new ows(target):new ows(target,protocols);
try{
if(String(url).indexOf("remote.mux")>=0){
var tag=String(url).slice(-24);
report({kind:"app-ws",outcome:"created",url:tag});
sock.addEventListener("open",function(){report({kind:"app-ws",outcome:"open",url:tag})});
sock.addEventListener("error",function(){report({kind:"app-ws",outcome:"error",url:tag})});
sock.addEventListener("close",function(e){report({kind:"app-ws",outcome:"close",code:e.code,url:tag})});
}
}catch(e){}
return sock;
};
WS.prototype=ows.prototype;
try{WS.CONNECTING=ows.CONNECTING;WS.OPEN=ows.OPEN;WS.CLOSING=ows.CLOSING;WS.CLOSED=ows.CLOSED}catch(e){}
try{Object.defineProperty(window,"WebSocket",{value:WS,writable:true,configurable:true});PATCH.ws=true}
catch(e){try{window.WebSocket=WS;PATCH.ws=(window.WebSocket===WS)}catch(e2){}}}
var ob=navigator.sendBeacon&&navigator.sendBeacon.bind(navigator);
if(ob){try{navigator.sendBeacon=function(url,data){return ob(toProxy(url),data)};PATCH.beacon=true}catch(e){}}
})();
// The frame is same-origin with the desktop shell (required for the stream
// WebSocket), so it would otherwise read the LOCAL app's persisted state —
// including the current session id — and ask the remote about a session it
// does not have. Give the remote its own namespaced storage instead.
(function(){
var PREFIX=${JSON.stringify(`dshctl:${ticket}:`)};
function wrap(store){
return new Proxy(store,{
get:function(t,k){
if(k==="getItem")return function(key){return t.getItem(PREFIX+String(key))};
if(k==="setItem")return function(key,value){return t.setItem(PREFIX+String(key),value)};
if(k==="removeItem")return function(key){return t.removeItem(PREFIX+String(key))};
if(k==="clear")return function(){Object.keys(t).filter(function(x){return x.indexOf(PREFIX)===0}).forEach(function(x){t.removeItem(x)})};
if(k==="key")return function(i){var keys=Object.keys(t).filter(function(x){return x.indexOf(PREFIX)===0});return keys[i]===undefined?null:keys[i].slice(PREFIX.length)};
if(k==="length")return Object.keys(t).filter(function(x){return x.indexOf(PREFIX)===0}).length;
var v=t[k];return typeof v==="function"?v.bind(t):v;
},
set:function(t,k,v){t.setItem(PREFIX+String(k),v);return true},
has:function(t,k){return t.getItem(PREFIX+String(k))!==null},
deleteProperty:function(t,k){t.removeItem(PREFIX+String(k));return true},
ownKeys:function(t){return Object.keys(t).filter(function(x){return x.indexOf(PREFIX)===0}).map(function(x){return x.slice(PREFIX.length)})},
getOwnPropertyDescriptor:function(t,k){var v=t.getItem(PREFIX+String(k));return v===null?undefined:{value:v,enumerable:true,configurable:true,writable:true}}
});
}
["localStorage","sessionStorage"].forEach(function(name){
try{var proxied=wrap(window[name]);Object.defineProperty(window,name,{configurable:true,get:function(){return proxied}})}catch(e){}
});
})();
var d=DIAG;
	function r(o){return report(o)}
	r({kind:"frame",baseURI:document.baseURI,secure:window.isSecureContext,transport:JSON.stringify(t),patches:JSON.stringify(PATCH)});
	var attempt=0;
	function probe(){
	attempt+=1;
	try{
	var w=new WebSocket(${JSON.stringify(`${base}api/remote.mux`.replace(/^http/,"ws"))});
	w.onopen=function(){r({kind:"frame-ws",outcome:"open",attempt:attempt})};
	w.onerror=function(){r({kind:"frame-ws",outcome:"error",attempt:attempt})};
	w.onclose=function(e){r({kind:"frame-ws",outcome:"close",code:e.code,attempt:attempt})};
	}catch(e){r({kind:"frame-ws",outcome:"throw",message:String(e),attempt:attempt})}
	if(attempt<4)setTimeout(probe,2500);
	}
	probe();
	}catch(e){try{console.error("dsh-control diag",e)}catch(_){}}
	})()</script>`;
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
							if (remote.statusCode === 401 && retried !== true) {
								// Cookie went stale (remote restarted). Re-mint once, then retry.
								remote.resume();
								authVerifiedAt = 0;
								if (typeof client.ensureCookie === "function") {
									const fresh = await client.ensureCookie().catch(() => false);
									if (fresh === true) authVerifiedAt = Date.now();
								}
								send(true);
								return;
							}
							if (cacheable && remote.statusCode === 200) {
								const chunks = [];
								remote.on("data", (chunk) => chunks.push(chunk));
								remote.on("end", () => {
									const body = Buffer.concat(chunks);
									cacheAsset(sub, body, headers);
									if (res.writableEnded || res.destroyed) return;
									res.writeHead(200, { ...headers, "cache-control": "private, max-age=31536000, immutable" });
									res.end(body);
								});
								remote.on("error", () => { try { res.destroy(); } catch { /* gone */ } });
								return;
							}
							if (remote.statusCode !== undefined && remote.statusCode !== 401) authVerifiedAt = Date.now();
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
				};
				await send(false);
			})
			.catch((error) => {
				if (res.writableEnded || res.destroyed) return;
				res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
				res.end(`dsh-control 代理内部错误：${error.message}`);
			});
	};

	/** Telemetry for mux frames: which endpoints the page opens, and any frame
	 *  carrying an application error. This is what makes a "session not found"
	 *  reproducible from the host log alone: the failing endpoint + sessionId
	 *  show up here if (and only if) the call went through the proxy. */
	const instrumentMux = (label) => {
		let budget = 40; // cap: enough to see a full panel interaction
		return (chunk) => {
			if (budget <= 0) return;
			const text = chunk.toString("utf8");
			for (const line of text.split("\n")) {
				if (line.length < 3) continue;
				try {
					const frame = JSON.parse(line);
					if (frame.type === "open") {
						logLine(`MUX ${label} open ${frame.endpoint} ${String(JSON.stringify(frame.payload?.args?.request?.sessionId ?? frame.payload?.args?.sessionId ?? "")).slice(0, 60)}`);
						budget -= 1;
					} else if (/not found|invalid|error/i.test(line)) {
						logLine(`MUX ${label} ${line.slice(0, 220)}`);
						budget -= 1;
					}
				} catch { /* partial frame across chunks — skip */ }
			}
		};
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
		const browserSide = instrumentMux("→");
		const remoteSide = instrumentMux("←");
		const upstream = createConnection({ host: "127.0.0.1", port }, () => {
			upstream.write(lines);
			if (head !== undefined && head.length > 0) upstream.write(head);
			// Telemetry only (never mutates the stream): which endpoints the page
			// opens and which frames carry errors, so a field repro names itself.
			socket.on("data", (chunk) => { try { browserSide(chunk); } catch { /* observe only */ } });
			upstream.on("data", (chunk) => { try { remoteSide(chunk); } catch { /* observe only */ } });
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
