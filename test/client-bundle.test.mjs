/**
 * Headless contract test for the client bundle (lib/client.js).
 *
 * Loads the browser bundle with a stub `window.__ModuleLoader__` + `require`,
 * runs `apply()` against a mock client context, and asserts the sidebar
 * contracts this plugin must honor:
 *
 *   1. exactly ONE sidebar tab type is registered, with a guide entry that
 *      carries title/description/icon (the sidebar renders the capsule);
 *   2. NO component is registered into "sidebar.right.tab.guide.entry" —
 *      that slot replaces the sidebar's own clickable capsule and would make
 *      the entry impossible to open (regression guard);
 *   3. the pane body and title slots are registered under the same key;
 *   4. no invalid `priority` band is passed (valid: extension|builtin|fallback).
 *
 * Run: node --test plugin/test/   (or: node plugin/test/client-bundle.test.mjs)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, "..", "lib", "client.js");

/** Load the bundle and return its exports plus every registration it made. */
async function loadBundle() {
	const source = await readFile(bundlePath, "utf8");

	let captured;
	globalThis.window = {
		__ModuleLoader__: {
			load(module) {
				captured = module;
			},
		},
	};

	const stubs = {
		react: {
			createElement: () => ({}),
			useState: () => [undefined, () => {}],
			useEffect: () => {},
			useCallback: (fn) => fn,
		},
		// Any named export resolves to a stub component/icon: the panel is
		// expected to build itself from the official primitives, and this
		// keeps the test independent of which ones it picks.
		"@deepseek-ai/dsh-client-ui-primitives": new Proxy({}, {
			get: (_target, key) => (typeof key === "string" && key !== "then" ? function PrimitiveStub() {} : undefined),
		}),
	};
	const requireStub = (id) => {
		if (Object.hasOwn(stubs, id)) return stubs[id];
		throw new Error(`unexpected require(${JSON.stringify(id)})`);
	};

	// eslint-disable-next-line no-new-func -- the bundle is an IIFE-style module body
	new Function("window", source)(globalThis.window);
	assert.ok(captured !== undefined, "bundle did not call window.__ModuleLoader__.load");
	assert.equal(captured.id, "dsh-control");

	const exports = captured.factory(requireStub);

	const tabs = [];
	const slots = [];
	const ctx = {
		effect: (fn) => {
			fn();
			return () => {};
		},
		get: () => undefined,
		sidebarRightTabs: {
			register: (definition) => {
				tabs.push(definition);
				return () => {};
			},
		},
		slots: {
			inject: (_name, fn) => {
				fn();
				return () => {};
			},
			register: (definition) => {
				slots.push(definition);
				return () => {};
			},
		},
	};
	exports.apply(ctx);
	return { exports, tabs, slots };
}

test("client bundle registers exactly one sidebar tab type with a valid band", async () => {
	const { tabs } = await loadBundle();
	assert.equal(tabs.length, 1, "expected exactly one sidebarRightTabs.register call");
	const tab = tabs[0];
	assert.equal(tab.id, "dsh-control");
	assert.equal(tab.kind, "dsh-control");
	if (tab.priority !== undefined) {
		assert.ok(
			["extension", "builtin", "fallback"].includes(tab.priority),
			`priority ${JSON.stringify(tab.priority)} is not a valid band (extension|builtin|fallback)`,
		);
	}
});

test("guide entry carries title, description and an icon", async () => {
	const { tabs } = await loadBundle();
	const [entry] = tabs[0].guide;
	assert.equal(typeof entry.title, "function");
	assert.equal(typeof entry.title(), "string");
	assert.equal(typeof entry.description, "function");
	assert.ok(entry.icon !== undefined, "guide entry needs an icon so the capsule matches sibling tabs");
	assert.equal(new Set(tabs[0].guide.map((g) => g.id)).size, tabs[0].guide.length, "duplicate guide entry ids");
});

test("regression: no component is registered into the clickable guide-entry slot", async () => {
	const { slots } = await loadBundle();
	const hijacked = slots.filter((slot) => slot.name === "sidebar.right.tab.guide.entry");
	assert.equal(
		hijacked.length,
		0,
		"registering into sidebar.right.tab.guide.entry replaces the sidebar's clickable capsule and breaks opening the tab",
	);
});

test("pane body and title register under the same key as the tab type", async () => {
	const { tabs, slots } = await loadBundle();
	const key = tabs[0].id;
	const paneSlots = slots.filter((slot) => slot.name.startsWith("sidebar.right.pane.tab"));
	assert.deepEqual(paneSlots.map((slot) => `${slot.name}#${slot.key}`).sort(), [
		`sidebar.right.pane.tab#${key}`,
		`sidebar.right.pane.tab.title#${key}`,
	]);
});

test("remote sessions are marked on their sidebar rows", async () => {
	const { slots } = await loadBundle();
	const byName = new Map(slots.map((slot) => [slot.name, slot]));
	// The leading seat is shared with status dots, so the trailing seat carries a
	// chip that stays visible while the session runs.
	assert.ok(byName.has("sidebar.session.row.leading"), "idle rows need the remote mark");
	assert.ok(byName.has("sidebar.workspaces.session.row.action"), "running rows need the remote chip");
	assert.match(String(byName.get("sidebar.session.row.leading").id), /dsh-control/);
	assert.match(String(byName.get("sidebar.workspaces.session.row.action").id), /dsh-control/);
	// Every registration must stay inside the documented seats.
	for (const slot of slots) {
		assert.ok(
			[
				"sidebar.right.pane.tab",
				"sidebar.right.pane.tab.title",
				"sidebar.session.row.leading",
				"sidebar.workspaces.session.row.action",
			].includes(slot.name),
			`unexpected slot registration: ${slot.name}`,
		);
	}
});

test("exports a cordis client plugin with services the panel needs", async () => {
	const { exports } = await loadBundle();
	assert.equal(typeof exports.apply, "function");
	assert.ok(Array.isArray(exports.inject));
	for (const service of ["slots", "connection", "sidebarRightTabs"]) {
		assert.ok(exports.inject.includes(service), `inject must include ${service}`);
	}
});

test("every connect failure maps to an actionable notice", async () => {
	const { exports } = await loadBundle();
	const { noticeFromConnectResult } = exports.__internals;

	// Auth rejection: the panel must carry a runnable fix plus retry and manual.
	const auth = noticeFromConnectResult({
		ok: true,
		value: {
			error: "这台服务器还没有接受你本机的密钥",
			detail: "自动连接需要免密登录",
			fix: { label: "在本机终端运行这一条", command: "ssh-copy-id -i ~/.ssh/id_ed25519.pub root@10.0.0.5" },
			manual: true,
			retry: true,
		},
	});
	assert.equal(auth.tone, "error");
	assert.equal(auth.fix.command, "ssh-copy-id -i ~/.ssh/id_ed25519.pub root@10.0.0.5");
	assert.equal(auth.retry, true, "a fixable failure must be retryable");
	assert.equal(auth.manual, true, "and must offer the manual path");

	// A transport-level failure still produces a readable message and no fix block.
	const transport = noticeFromConnectResult({ ok: false, error: { message: "调用失败：HTTP 500" } });
	assert.equal(transport.text, "调用失败：HTTP 500");
	assert.equal(transport.fix, undefined);
	assert.equal(transport.retry, false);

	// A clean success produces no notice at all: the panel shows its success path.
	assert.equal(noticeFromConnectResult({ ok: true, value: {} }), undefined);

	// Anything undescribed still yields a readable notice rather than a blank one.
	const weird = noticeFromConnectResult({ ok: false, value: {} });
	assert.equal(typeof weird.text, "string");
	assert.notEqual(weird.text, "");
});

test("row helpers are total: status, reconnect and summary", async () => {
	const { exports } = await loadBundle();
	const { statusOf, needsReconnect, environmentSummary } = exports.__internals;

	assert.equal(statusOf({ status: "connected", ready: true }).dot, "done");
	assert.equal(statusOf({ status: "unreachable", ready: true }).dot, "error");
	assert.equal(statusOf({ status: "unreachable", ready: true }).label, "已断开");
	assert.equal(statusOf({}).label, "未检测", "an unknown status must fall back, not crash");
	assert.equal(statusOf({ status: "connected", ready: false }).dot, "warning", "missing credentials outrank a stale probe");

	assert.equal(needsReconnect({ status: "connected" }), false);
	assert.equal(needsReconnect({ status: "unreachable" }), true);
	assert.equal(needsReconnect({}), true);

	// The summary states whether the environment has its Workspace, because an
	// environment without one has nowhere to appear in the sidebar.
	assert.equal(
		environmentSummary({ status: "connected", sshTarget: "root@h", workspace: { path: "/tmp/x" } }),
		"已连接 · root@h · 已有工作区",
	);
	assert.equal(
		environmentSummary({ status: "connected", sshTarget: "root@h" }),
		"已连接 · root@h · 无工作区",
	);
	assert.equal(
		environmentSummary({ status: "connected", endpoint: "http://127.0.0.1:1" }),
		"已连接 · http://127.0.0.1:1 · 无工作区",
	);
});

test("a connection that could not create its Workspace is reported, not swallowed", async () => {
	const { exports } = await loadBundle();
	const { noticeFromConnectResult } = exports.__internals;

	const connected = noticeFromConnectResult({ ok: true, value: { name: "cn-dsh2", sessions: 3 } });
	assert.equal(connected, undefined, "a clean connect shows no notice");

	const degraded = noticeFromConnectResult({
		ok: true,
		value: { name: "cn-dsh2", sessions: 3, workspaceError: "当前 profile 没有工作区能力" },
	});
	assert.equal(degraded.tone, "error");
	assert.match(degraded.text, /工作区没有建成/);
	assert.match(degraded.text, /没有工作区能力/);
	assert.equal(degraded.retry, true);

	const failed = noticeFromConnectResult({ ok: false, error: { message: "SSH 认证失败" } });
	assert.equal(failed.text, "SSH 认证失败");
});
