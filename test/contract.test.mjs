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

test("the remote-environment page uses the host-provided URL verbatim", () => {
	// The host returns an absolute URL on purpose (custom-scheme shells make a
	// relative frame URL resolve to `ws://app/...`); the page must not rebuild it.
	assert.match(clientSource, /api\("proxyUrl"/, "page asks the host for the URL");
	assert.match(clientSource, /setFrameUrl\(result\.value\.url\)/, "URL is taken from the answer");
	assert.match(clientSource, /src:\s*frameUrl/, "iframe src is that URL");
});

test("proxy mounts are disposed on environment removal and plugin unload", () => {
	assert.match(hostSource, /proxyMounts\.delete\(name\)/, "removal disposes the mount");
	assert.match(hostSource, /for \(const \{ dispose \} of this\.proxyMounts\.values\(\)\)/, "unload disposes every mount");
});

test("the tunnel keeper re-verifies adopted listeners", () => {
	const tunnelSource = readFileSync(join(here, "..", "lib", "tunnel.js"), "utf8");
	assert.match(tunnelSource, /existing\.adopted !== true\) return \{ ok: true \}/, "spawned tunnels are trusted");
	assert.match(tunnelSource, /waitForPort\(spec\.localPort, 300\)/, "adopted listeners are probed");
});
