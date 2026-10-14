/**
 * Workspace helpers: one local Workspace per connected remote environment.
 *
 * Product decision: connecting an environment also gives it a local Workspace
 * (a directory + title in the sidebar), so sessions created "in that
 * environment" have a natural home.
 *
 * Location: `$DSH_HOME/workspaces/<name>`, i.e. under dsh's own home rather
 * than the OS Documents folder — always writable, predictable, and independent
 * of first-use initialization (which the harness only performs on a pristine
 * install, so it is unavailable to anyone who already has sessions).
 * A name collision gains a `(1)`, `(2)` … suffix. Removing the environment
 * removes the registration but never the directory or its files.
 */
import { join } from "node:path";

/** Base directory holding environment workspaces for one dsh home. */
export function workspaceBaseDirectory(dshHome) {
	return join(dshHome, "workspaces");
}

/** Pick a free sibling name for `name`, using `(1)`, `(2)` … on collision. */
export async function nextWorkspacePath(base, name, exists) {
	for (let index = 0; index < 100; index += 1) {
		const candidate = join(base, index === 0 ? name : `${name} (${index})`);
		if (!(await exists(candidate))) return candidate;
	}
	return join(base, `${name} (${Date.now()})`);
}

/**
 * How one Workspace attempt changes an environment spec.
 *
 * Pure and total on purpose: every path that establishes an environment feeds
 * its result through here, so an environment can only ever end up as either
 * "has a Workspace" or "carries the reason it does not". A failure is recorded
 * rather than dropped — a silently missing Workspace is exactly the failure
 * that is impossible to diagnose from the outside.
 *
 * @param spec - the environment spec as stored.
 * @param result - `{ok:true, workspaceId, path}` or `{ok:false, error}`.
 * @returns a new spec; no other field is ever lost.
 */
export function applyWorkspaceResult(spec, result) {
	if (result?.ok === true && typeof result.workspaceId === "string" && result.workspaceId !== "") {
		const { workspaceError: _dropped, ...rest } = spec ?? {};
		return { ...rest, workspaceId: result.workspaceId, workspacePath: result.path };
	}
	return { ...(spec ?? {}), workspaceError: result?.error ?? "工作区创建失败" };
}

/**
 * Poll a synchronous probe until it yields a value.
 *
 * Services activate asynchronously, so "ask once and give up" is wrong for
 * anything a plugin needs at startup. `now`/`sleep` are injectable so the
 * timing behaviour is testable without waiting in real time.
 *
 * @param probe - returns the value, or undefined while it is still unavailable.
 * @returns the first value, or undefined once the timeout passes.
 */
export async function pollUntil(probe, options = {}) {
	const { timeoutMs = 10_000, intervalMs = 200, now = () => Date.now(), sleep = defaultSleep } = options;
	const deadline = now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined) return value;
		if (now() >= deadline) return undefined;
		await sleep(intervalMs);
	}
}

function defaultSleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
