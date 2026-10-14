/**
 * Unit tests for the workspace helpers (lib/workspace.js).
 * The helpers are pure: the existence predicate is injected, so no filesystem
 * is touched and the collision rules are pinned down.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyWorkspaceResult, nextWorkspacePath, pollUntil, workspaceBaseDirectory } from "../lib/workspace.js";

const HOME = "/home/me/.dsh";
const BASE = `${HOME}/workspaces`;

test("workspaces live under the dsh home, not the OS Documents folder", () => {
	assert.equal(workspaceBaseDirectory(HOME), BASE);
});

test("first free name is the plain environment name", async () => {
	const path = await nextWorkspacePath(BASE, "build-box", async () => false);
	assert.equal(path, `${BASE}/build-box`);
});

test("collisions gain (1), (2), … suffixes", async () => {
	const taken = new Set([`${BASE}/build-box`, `${BASE}/build-box (1)`]);
	const path = await nextWorkspacePath(BASE, "build-box", async (candidate) => taken.has(candidate));
	assert.equal(path, `${BASE}/build-box (2)`);
});

test("environment names are used verbatim and stay inside the base directory", async () => {
	const path = await nextWorkspacePath(BASE, "10.0.0.5", async () => false);
	assert.equal(path, `${BASE}/10.0.0.5`);
	assert.ok(path.startsWith(`${BASE}/`), "the workspace must stay inside the base directory");
});

test("a pathological full house still yields a unique path", async () => {
	const path = await nextWorkspacePath(BASE, "x", async () => true);
	assert.ok(path.startsWith(`${BASE}/x (1`), `expected a suffixed fallback, got ${path}`);
	assert.notEqual(path, `${BASE}/x`);
});

// ---------------------------------------------------------------------------
// Failure must be recorded, never dropped: an environment can only be in one of
// two states — it has a Workspace, or it carries the reason it does not.
// ---------------------------------------------------------------------------

test("a successful attempt records the workspace and clears any earlier failure", () => {
	const spec = { name: "box", sshTarget: "root@h", workspaceError: "上次失败" };
	const updated = applyWorkspaceResult(spec, { ok: true, workspaceId: "w1", path: `${BASE}/box` });
	assert.equal(updated.workspaceId, "w1");
	assert.equal(updated.workspacePath, `${BASE}/box`);
	assert.equal("workspaceError" in updated, false, "a healed environment must not keep a stale error");
	assert.equal(updated.name, "box");
	assert.equal(updated.sshTarget, "root@h", "no other field may be lost");
});

test("a failed attempt records the reason and keeps the environment intact", () => {
	const spec = { name: "box", sshTarget: "root@h", endpoint: "http://127.0.0.1:1" };
	const updated = applyWorkspaceResult(spec, { ok: false, error: "当前 profile 没有工作区能力" });
	assert.equal(updated.workspaceError, "当前 profile 没有工作区能力");
	assert.equal(updated.workspaceId, undefined);
	assert.equal(updated.endpoint, "http://127.0.0.1:1");
});

test("a failure with no message still records something readable", () => {
	assert.equal(typeof applyWorkspaceResult({ name: "box" }, { ok: false }).workspaceError, "string");
	assert.notEqual(applyWorkspaceResult({ name: "box" }, undefined).workspaceError, "");
	// A "success" without an id is not a success.
	const bogus = applyWorkspaceResult({ name: "box" }, { ok: true });
	assert.equal(bogus.workspaceId, undefined);
	assert.ok(bogus.workspaceError, "an id-less result is a failure, not a silent pass");
});

// ---------------------------------------------------------------------------
// Services activate asynchronously: waiting for one is behaviour worth pinning.
// ---------------------------------------------------------------------------

test("polling returns the service as soon as it appears", async () => {
	let attempts = 0;
	const service = await pollUntil(() => (++attempts >= 3 ? { ready: true } : undefined), { timeoutMs: 1_000, sleep: async () => {} });
	assert.deepEqual(service, { ready: true });
	assert.equal(attempts, 3);
});

test("polling gives up at the deadline instead of hanging forever", async () => {
	let clock = 0;
	let calls = 0;
	const result = await pollUntil(() => { calls += 1; return undefined; }, {
		timeoutMs: 500,
		intervalMs: 100,
		now: () => clock,
		sleep: async (ms) => { clock += ms; },
	});
	assert.equal(result, undefined);
	assert.ok(calls >= 5 && calls <= 7, `expected ~6 probes, got ${calls}`);
});

test("an already-available service is returned without waiting", async () => {
	let slept = 0;
	const service = await pollUntil(() => "here", { sleep: async () => { slept += 1; } });
	assert.equal(service, "here");
	assert.equal(slept, 0);
});
