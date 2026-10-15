/**
 * Structural invariants for the host half.
 *
 * These exist because of a real defect: `adopt()` (the manual paste path)
 * established an environment WITHOUT establishing its Workspace, and the whole
 * suite stayed green — every test drove the one-click `connect()` path only.
 *
 * The lesson is not "add a test for adopt" but "every path that reaches the
 * same outcome must be covered by the same invariant", so a future path cannot
 * quietly skip a step. These assertions read the source on purpose: they are
 * about structure, not behaviour, and structure is what regressed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");

/** Body of one class method, by brace matching from its declaration. */
function methodBody(name) {
	// Declarations appear as `\tasync name(` or `\tname(`; calls are never indented
	// by exactly one tab at the start of a line, so this cannot match a call site.
	const declaration = new RegExp(`^\\t(?:async )?${name}\\(`, "m");
	const match = declaration.exec(source);
	assert.notEqual(match, null, `method ${name}() must exist`);
	const start = match.index;
	const open = source.indexOf("{", start);
	let depth = 0;
	for (let index = open; index < source.length; index += 1) {
		if (source[index] === "{") depth += 1;
		else if (source[index] === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(open, index + 1);
		}
	}
	throw new Error(`unbalanced braces in ${name}()`);
}

/** Every entry point that ends with a usable, connected environment. */
const ESTABLISHING_PATHS = ["connect", "adopt", "reconnect", "healWorkspaces"];

test("every path that establishes an environment also establishes its Workspace", () => {
	for (const name of ESTABLISHING_PATHS) {
		assert.match(
			methodBody(name),
			/ensureWorkspaceAndKeep\(/,
			`${name}() must give the environment its Workspace — a connected environment without one is invisible in the sidebar`,
		);
	}
});

test("the Workspace decision has exactly one implementation", () => {
	// The helper owns the outcome; no path may hand-roll spec fields around it.
	assert.match(methodBody("ensureWorkspaceAndKeep"), /applyWorkspaceResult\(/);
	assert.match(
		methodBody("healWorkspaces"),
		/ensureWorkspaceAndKeep\(/,
		"the startup repair must reuse the same step, not reimplement it",
	);
});

test("a service needed at startup is waited for, never read once and abandoned", () => {
	// Services activate asynchronously; reading one eagerly at load time is what
	// made the startup repair fail with "当前 profile 没有工作区能力".
	assert.match(methodBody("ensureWorkspace"), /waitForWorkspaceController\(/);
	assert.match(methodBody("waitForWorkspaceController"), /pollUntil\(/);
});

test("the panel is told about a missing Workspace, not just handed a success", () => {
	const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
	// Both entry points (one-click and manual) must consult the same verdict.
	const guards = client.match(/notice = noticeFromConnectResult\(result\)/g) ?? [];
	assert.equal(guards.length, 3, "connect(), adopt() and adoptDirect() must all route the result through the notice verdict");
	assert.match(client, /workspaceError/, "the panel must know why a Workspace is missing");
});

test("an environment row separates its name from the status summary", () => {
	// Regression: the row renders name + summary adjacently, so a missing
	// separator produced "cn-dsh2已连接" in the panel.
	const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
	const line = client.split("\n").find((row) => row.includes("collapsedContent"));
	assert.ok(line, "the environment row must render a summary");
	assert.match(line, /` · \$\{summary\}`/, "the summary must carry its own separator; the row adds no spacing");
});
