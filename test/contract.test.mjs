/**
 * Contract tests between the client bundle and the host service.
 *
 * These pin the wiring rules that repeatedly broke during development:
 *  - every `api("<name>")` the client calls must be a registered Remote
 *    method (a missing registration surfaces only at runtime);
 *  - the remote-environment page must use the URL the host hands back
 *    verbatim (the host decides absolute-vs-relative because the desktop
 *    shell serves pages from a custom scheme);
 *  - the proxy mounts must be disposed with the plugin and with a removed
 *    environment (a leak would keep forwarding to a dead tunnel).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(here, "..", "lib", "client.js"), "utf8");
const hostSource = readFileSync(join(here, "..", "lib", "index.js"), "utf8");

function registeredMethods() {
	const list = hostSource.match(/for \(const method of \[([^\]]+)\]/);
	assert.ok(list !== null, "host registers Remote methods in one list");
	return new Set([...list[1].matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]));
}

test("every api() the client calls is a registered Remote method", () => {
	const called = [...clientSource.matchAll(/api\("([a-zA-Z]+)"/g)].map((m) => m[1]);
	assert.ok(called.length > 0, "client calls the host");
	const missing = [...new Set(called)].filter((name) => !registeredMethods().has(name));
	assert.deepEqual(missing, [], `unregistered client calls: ${missing.join(", ")}`);
});

test("every component the client renders is defined (no ReferenceError at runtime)", () => {
	// A missing component only crashes when that branch renders — the whole
	// panel went blank this way once. Catch it statically.
	const defined = new Set([
		...[...clientSource.matchAll(/function\s+([A-Z]\w*)\s*\(/g)].map((m) => m[1]),
	]);
	for (const block of clientSource.matchAll(/const\s*\{([^}]*)\}\s*=\s*(?:react|primitives);/g)) {
		for (const name of block[1].split(",")) {
			const clean = name.trim().split(":")[0].trim();
			if (clean) defined.add(clean);
		}
	}
	const used = new Set([...clientSource.matchAll(/h\(([A-Z]\w*)[,)\s]/g)].map((m) => m[1]));
	const missing = [...used].filter((name) => !defined.has(name));
	assert.deepEqual(missing, [], `rendered but never defined: ${missing.join(", ")}`);
});

test("the remote-environment page uses the host-provided URL verbatim", () => {
	// The host returns an absolute URL on purpose (custom-scheme shells make a
	// relative frame URL resolve to `ws://app/...`); the page must not rebuild it.
	assert.match(clientSource, /api\("proxyUrl"/, "page asks the host for the URL");
	assert.match(clientSource, /setFrameUrl\(result\.value\.url\)/, "URL is taken from the answer");
	assert.match(clientSource, /src:\s*frameUrl/, "iframe src is that URL");
});

test("「打开界面」jumps to the in-app page; the browser window stays a secondary action", () => {
	// Opening a separate browser window was the old behaviour; now that the
	// full UI renders in-app, the primary action must select that panel.
	assert.match(clientSource, /const openInApp = \(environment\) => \{/, "in-app jump exists");
	assert.match(clientSource, /selectPanel\(REMOTE_ENV_PANEL\)/, "selects our main panel");
	assert.match(clientSource, /const openInBrowser = useCallback/, "browser action kept as secondary");
	assert.match(clientSource, /onClick: \(\) => openInterface\(environment\.name\)/, "primary button uses the in-app jump");
	assert.match(clientSource, /onClick: \(\) => openInBrowser\(environment\.name\)/, "secondary button opens the browser");
	assert.doesNotMatch(clientSource, /onClick: \(\) => openInterface[\s\S]{0,200}window\.open/, "the primary button must not open a window");
});

test("the remote-environment iframe lives in a persistent overlay (panel switches must not reload it)", () => {
	// Switching to a local session unmounts the main-slot page. The iframe must
	// live in the root overlay instead, or every switch reloads the remote GUI.
	assert.match(clientSource, /slots\.inject\("shell\.overlay"/, "host registered in the root overlay");
	assert.match(clientSource, /remoteEnvHost\.set\(\{ active: false \}\)/, "controller deactivates on unmount");
	assert.match(clientSource, /h\("iframe", \{ ref: frameRef, src: frameUrl/, "iframe owned by the overlay host");
	assert.doesNotMatch(clientSource, /function RemoteEnvPage[\s\S]{0,4000}h\("iframe"/, "the main-slot controller must not own the iframe");
});

test("proxy mounts are disposed on environment removal and plugin unload", () => {
	assert.match(hostSource, /proxyMounts\.delete\(name\)/, "removal disposes the mount");
	assert.match(hostSource, /for \(const \{ dispose \} of this\.proxyMounts\.values\(\)\)/, "unload disposes every mount");
});

test("client timers are visibility-aware and event-driven (no idle polling)", () => {
	// Two resource rules that are easy to regress in UI code:
	//  - the 15 s remote-session poll must skip a hidden window;
	//  - the remote-env page must size itself from ResizeObserver, not a timer.
	assert.match(clientSource, /document\.hidden === true\) return;/, "session poll skips hidden windows");
	assert.match(clientSource, /new ResizeObserver/, "overlay sizing uses ResizeObserver");
	assert.doesNotMatch(clientSource, /setInterval\(measure, 500\)/, "no 500 ms layout poll");
});

test("the tunnel keeper verifies the port on every ensure (no blind trust)", () => {
	// Trusting a live child process is how a half-dead ssh went unnoticed: the
	// process lived, its -L listener did not, and every request hit ECONNREFUSED
	// until the user pressed 重连. ensure() must probe reality every time; the
	// supervisor only exists as a slow backstop.
	const tunnelSource = readFileSync(join(here, "..", "lib", "tunnel.js"), "utf8");
	assert.match(tunnelSource, /Never trust bookkeeping/, "the rule is documented where it matters");
	assert.match(tunnelSource, /if \(await waitForPort\(spec\.localPort, 300\)\) return \{ ok: true \};/, "every ensure probes the port");
	assert.doesNotMatch(tunnelSource, /existing\.adopted !== true\) return \{ ok: true \}/, "spawned tunnels are no longer trusted blindly");
});
