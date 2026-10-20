/**
 * Exhaustive behavioural coverage for the frame shim the proxy injects.
 *
 * The shim runs as the first script inside the remote UI's document, so a bug
 * here breaks the embedded page in ways no unit test on the proxy sees. These
 * tests execute the *actual served script* inside a vm with fakes for every
 * global it touches, then assert the semantics the remote UI depends on:
 *
 *  - WebSocket: static constants survive (a wrapper without `WebSocket.OPEN`
 *    was the prime suspect for the embedded UI staying "connecting"),
 *    `instanceof` holds, listeners fire, and diagnostics are posted;
 *  - URL rewriting: same-host absolute paths get the mount prefix, foreign
 *    origins and already-prefixed URLs are left untouched;
 *  - storage: the frame sees its own namespace only, two environments never
 *    see each other's keys, and `clear()` stays inside the namespace;
 *  - the transport guard keeps our `streamBaseUrl` against later assignment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import vm from "node:vm";
import { mountEnvironmentProxy } from "../lib/proxy.js";
import { fakeWebServer, listen, close, get } from "./helpers.mjs";

/** Minimal Storage fake: keys as own properties, like the real one. */
class FakeStorage {
	constructor() { Object.defineProperty(this, "length", { get() { return Object.keys(this).filter((k) => typeof this[k] !== "function").length; }, configurable: true }); }
	getItem(key) { const v = this[key]; return typeof v === "string" ? v : null; }
	setItem(key, value) { this[key] = String(value); }
	removeItem(key) { delete this[key]; }
	clear() { for (const key of Object.keys(this)) if (typeof this[key] !== "function") delete this[key]; }
	key(index) { const keys = Object.keys(this).filter((k) => typeof this[k] !== "function"); return keys[index] ?? null; }
}

/** Minimal WebSocket fake with the statics the app reads. */
class FakeWebSocket {
	static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
	constructor(url) { this.url = url; this.readyState = FakeWebSocket.CONNECTING; this.listeners = {}; }
	addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
	dispatch(type, event = {}) { for (const fn of this.listeners[type] ?? []) fn(event); }
	send() {}
}

class FakeEventSource {
	constructor(url, options) { this.url = url; this.options = options; }
}

async function serveInstrumented(envName = "cn") {
	const upstream = createServer((req, res) => {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end("<html><head></head><body>x</body></html>");
	});
	const upstreamPort = await listen(upstream);
	const web = fakeWebServer();
	const mount = mountEnvironmentProxy(web, envName, () => ({
		endpoint: `http://127.0.0.1:${upstreamPort}`, cookieName: "c", cookie: "v",
		ensureCookie: async () => true,
	}));
	const webPort = await listen(web.server);
	const answer = await get(`http://127.0.0.1:${webPort}${mount.prefix}/`, { accept: "text/html" });
	const start = answer.body.indexOf("<script>(function(){");
	const end = answer.body.indexOf("</script>", start);
	assert.ok(start >= 0 && end > start, "injected script present");
	return {
		script: answer.body.slice(start + "<script>".length, end),
		base: `http://127.0.0.1:${webPort}${mount.prefix}/`,
		prefix: `${mount.prefix}/`,
		host: `127.0.0.1:${webPort}`,
		cleanup: async () => { await close(web.server); await close(upstream); },
	};
}

/** Build a page realm, run the served script in it, return the realm. */
function runShim(script, { base, host }) {
	const diag = [];
	const wsSockets = [];
	const posts = [];
	const errors = [];
	const realm = {
		URL,
		// The injected script swallows its own internal errors via a catch-all
		// that logs here. Silencing this is how the PATCH scoping regression
		// shipped green: the ReferenceError was invisible to every test.
		console: { error(...args) { errors.push(args.map(String).join(" ")); } },
		setTimeout() {},
		location: { origin: `http://${host}`, host, protocol: "http:", href: base },
		document: { baseURI: base },
		localStorage: new FakeStorage(),
		sessionStorage: new FakeStorage(),
		fetch: (url, init) => { diag.push(String(url)); posts.push({ url: String(url), body: String(init?.body ?? "") }); return Promise.resolve({}); },
		Request: class { constructor(url) { this.url = url; } },
		XMLHttpRequest: class { open(method, url) { diag.push(String(url)); } },
		EventSource: FakeEventSource,
		WebSocket: FakeWebSocket,
		navigator: { sendBeacon: (url) => { diag.push(String(url)); return true; } },
	};
	realm.globalThis = realm;
	realm.window = realm;
	const stores = { localStorage: realm.localStorage, sessionStorage: realm.sessionStorage };
	let error = null;
	try { vm.runInNewContext(script, realm, { filename: "injected.js" }); }
	catch (e) { error = e; }
	// Any swallowed internal error fails whichever test is running.
	assert.deepEqual(errors, [], "the injected script swallowed an internal error");
	return { realm, diag, posts, wsSockets, stores, error, errors };
}

test("WebSocket wrapper keeps statics, instanceof and listener wiring", async () => {
	const served = await serveInstrumented();
	try {
		const { realm, diag } = runShim(served.script, served);
		const WS = realm.WebSocket;

		assert.equal(WS.CONNECTING, 0, "CONNECTING survives the wrapper");
		assert.equal(WS.OPEN, 1, "OPEN survives the wrapper — the app compares readyState against it");
		assert.equal(WS.CLOSING, 2);
		assert.equal(WS.CLOSED, 3);

		// Same-host unprefixed mux URL: must gain the mount prefix.
		const sock = new WS(`ws://${served.host}/api/remote.mux`);
		assert.ok(sock instanceof WS, "created socket passes instanceof");
		assert.ok(sock instanceof FakeWebSocket, "still the real class underneath");
		assert.equal(sock.url, `ws://${served.host}${served.prefix}api/remote.mux`, "mux url rewritten");
		sock.readyState = FakeWebSocket.OPEN;
		assert.ok(sock.readyState === WS.OPEN, "readyState compares against wrapper static");

		sock.dispatch("open");
		sock.dispatch("close", { code: 1006 });
		const posted = diag.filter((url) => url.includes("__diag")).length;
		assert.ok(posted >= 2, "lifecycle posted to the diag sink");

		// Already-prefixed URL is left alone (this is the streamBaseUrl path).
		const direct = new WS(`ws://${served.host}${served.prefix}api/remote.mux`);
		assert.equal(direct.url, `ws://${served.host}${served.prefix}api/remote.mux`);
		// A foreign host is never rewritten.
		const foreign = new WS("wss://example.com/api/remote.mux");
		assert.equal(foreign.url, "wss://example.com/api/remote.mux");
	} finally {
		await served.cleanup();
	}
});

test("same-host absolute requests gain the prefix; foreign and prefixed do not", async () => {
	const served = await serveInstrumented();
	try {
		const { realm, diag } = runShim(served.script, served);
		// The shim posts its own startup diagnostics, so assert by content.
		const saw = (needle) => diag.find((url) => url.includes(needle));
		realm.fetch("/sidebar/api/settings.get");
		realm.fetch(`https://cdn.example.com/x.js`);
		realm.fetch(`${served.prefix}api/session/list`);
		new realm.XMLHttpRequest().open("POST", "/api/session/list");
		realm.navigator.sendBeacon("/api/telemetry");
		const es = new realm.EventSource("/plugins/events", { withCredentials: true });

		assert.equal(saw("sidebar/api"), `${served.base}sidebar/api/settings.get`, "sidebar api goes through the proxy");
		assert.equal(saw("cdn.example.com"), "https://cdn.example.com/x.js", "foreign origin untouched");
		assert.ok(diag.includes(`${served.prefix}api/session/list`), "already prefixed untouched");
		assert.ok(diag.includes(`${served.base}api/session/list`), "XHR rewritten to the absolute base");
		assert.equal(saw("api/telemetry"), `${served.base}api/telemetry`, "sendBeacon rewritten");
		assert.equal(es.url, `${served.base}plugins/events`, "EventSource rewritten");
		assert.deepEqual(es.options, { withCredentials: true }, "EventSource options preserved");
	} finally {
		await served.cleanup();
	}
});

test("a custom-scheme document (desktop shell) still gets absolute requests rewritten", async () => {
	// The desktop shell serves the frame from dsh-app://app/…. The first version
	// of the rewriter only allowed http/https/ws/wss, so EVERY absolute request
	// in the desktop was passed through untouched and hit the local app — the
	// exact "session not found" symptom, invisible in the http sandbox.
	const served = await serveInstrumented();
	try {
		const realm = {
			URL,
			console: { error(...args) { throw new Error("swallowed: " + args.join(" ")); } },
			setTimeout() {},
			location: { origin: "dsh-app://app", host: "app", protocol: "dsh-app:", href: served.base },
			document: { baseURI: `dsh-app://app${served.prefix}` },
			localStorage: new FakeStorage(),
			sessionStorage: new FakeStorage(),
			fetch: (url) => { realm.seen.push(String(url)); return Promise.resolve({}); },
			Request: class { constructor(url) { this.url = url; } },
			XMLHttpRequest: class { open(method, url) { realm.seen.push(String(url)); } },
			EventSource: FakeEventSource,
			WebSocket: FakeWebSocket,
			navigator: {},
		};
		realm.seen = [];
		realm.globalThis = realm;
		realm.window = realm;
		vm.runInNewContext(served.script, realm, { filename: "injected.js" });

		realm.fetch("/sidebar/api/fs.trees");
		const rewritten = realm.seen.find((u) => u.includes("sidebar/api"));
		assert.equal(rewritten, `dsh-app://app${served.prefix}sidebar/api/fs.trees`, "custom-scheme absolute path is prefixed");
		// Foreign scheme/host still untouched.
		realm.fetch("https://example.com/x");
		assert.ok(realm.seen.includes("https://example.com/x"), "foreign origin untouched");
	} finally {
		await served.cleanup();
	}
});

test("the frame's storage is namespaced per environment and clear() stays inside", async () => {
	const a = await serveInstrumented("alpha");
	const b = await serveInstrumented("beta");
	try {
		const ra = runShim(a.script, a);
		const rb = runShim(b.script, b);

		ra.realm.localStorage.setItem("dsh.sessions.current", "alpha-session");
		assert.equal(ra.realm.localStorage.getItem("dsh.sessions.current"), "alpha-session", "roundtrip inside the namespace");
		assert.deepEqual(Object.keys(ra.realm.localStorage), ["dsh.sessions.current"], "logical keys only");
		assert.ok(ra.realm.localStorage.getItem("never-set") === null);

		// The real backing store carries the ticket-prefixed key…
		assert.ok(Object.getOwnPropertyNames(ra.stores.localStorage).some((k) => k.startsWith("dshctl:") && k.includes(":dsh.sessions.current")), "backing key is prefixed");

		// …and the other environment cannot see it.
		assert.ok(rb.realm.localStorage.getItem("dsh.sessions.current") === null, "other env sees nothing");
		rb.realm.sessionStorage.setItem("ui", "1");
		assert.ok(ra.realm.sessionStorage.getItem("ui") === null, "sessionStorage is isolated too");

		// clear() wipes only this frame's namespace — never the host page's keys.
		// A "foreign" key is one written straight to the backing store (the host
		// page does that outside the frame's proxy).
		ra.stores.localStorage.setItem("dsh.host.key", "keep");
		ra.realm.localStorage.clear();
		assert.ok(ra.realm.localStorage.getItem("dsh.sessions.current") === null, "own namespace cleared");
		assert.equal(ra.stores.localStorage.getItem("dsh.host.key"), "keep", "host page keys survive clear()");
	} finally {
		await a.cleanup();
		await b.cleanup();
	}
});

test("the startup diagnostic posts with the patch status attached", async () => {
	const served = await serveInstrumented();
	try {
		const { posts, error } = runShim(served.script, served);
		const boot = posts.find((p) => p.url.includes("__diag") && p.body.includes('"kind":"frame"'));
		assert.ok(boot, `startup frame diagnostic posted (error=${error?.message ?? "none"}, posts=${posts.length})`);
		const patches = JSON.parse(JSON.parse(boot.body).patches);
		assert.equal(patches.fetch, true, "fetch patched in a normal realm");
		assert.equal(patches.xhr, true);
		assert.equal(patches.ws, true);
	} finally {
		await served.cleanup();
	}
});

test("a frozen fetch accessor is reported, not silently assumed patched", async () => {
	// If the desktop preload exposes fetch as a getter-only accessor, neither
	// defineProperty nor assignment can replace it. The shim must say so in its
	// startup diagnostic instead of pretending the rewrite is active.
	const served = await serveInstrumented();
	try {
		const realm = {
			URL,
			console: { error() {} },
			setTimeout() {},
			location: { origin: `http://${served.host}`, host: served.host, protocol: "http:", href: served.base },
			document: { baseURI: served.base },
			localStorage: new FakeStorage(),
			sessionStorage: new FakeStorage(),
			Request: class { constructor(url) { this.url = url; } },
			XMLHttpRequest: class { open(method, url) { this.opened = String(url); } },
			EventSource: FakeEventSource,
			WebSocket: FakeWebSocket,
			navigator: {},
		};
		// The frozen accessor still lands in our recorder — the point is that the
		// SHIM cannot replace it, not that the network is dead.
		const native = (url, init) => { posts.push({ url: String(url), body: String(init?.body ?? "") }); return Promise.resolve({}); };
		Object.defineProperty(realm, "fetch", { get() { return native; }, configurable: false });
		const diag = [];
		const posts = [];
		const errors = [];
		realm.console = { error(...args) { errors.push(args.map(String).join(" ")); } };
		realm.globalThis = realm;
		realm.window = realm;
		vm.runInNewContext(served.script, realm, { filename: "injected.js" });

		assert.deepEqual(errors, [], "no swallowed internal errors in the frozen realm either");
		assert.equal(realm.fetch, native, "native fetch untouched when frozen");
		// The diag reporter itself calls the (frozen) fetch — our stub — so the
		// startup report still lands and must confess that fetch stayed native.
		const boot = posts.find((p) => p.url.includes("__diag") && p.body.includes('"kind":"frame"'));
		assert.ok(boot, "startup diagnostic posted");
		const patches = JSON.parse(JSON.parse(boot.body).patches);
		assert.equal(patches.fetch, false, "frozen fetch honestly reported as unpatched");
		// XHR lives on the prototype and stays patchable.
		const xhr = new realm.XMLHttpRequest();
		xhr.open("GET", "/sidebar/api/fs.trees");
		assert.equal(xhr.opened, `${served.base}sidebar/api/fs.trees`, "XHR still rewrites when fetch is frozen");
	} finally {
		await served.cleanup();
	}
});

test("a later assignment to __DSH_TRANSPORT__ keeps our streamBaseUrl", async () => {
	const served = await serveInstrumented();
	try {
		const { realm } = runShim(served.script, served);
		realm.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl: "http://elsewhere/" };
		assert.equal(realm.__DSH_TRANSPORT__.streamBaseUrl, served.base, "our base wins");
		assert.equal(realm.__DSH_TRANSPORT__.ownsHost, true, "their fields survive the merge");
	} finally {
		await served.cleanup();
	}
});
