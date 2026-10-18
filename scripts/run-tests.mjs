/**
 * One entry point for the full test suite.
 *
 * Every iteration must end with this green — the project's rule is that a
 * feature is not done until the complete suite passes (see AGENTS.md).
 *
 * Each file runs in its own process with a hard timeout: a wedged test must
 * fail the run instead of blocking it, which is exactly how several proxy
 * regressions used to hide.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const timeoutMs = Number(process.env.DSH_TEST_TIMEOUT_MS ?? 120_000);

const files = readdirSync(join(root, "test"))
	.filter((name) => name.endsWith(".test.mjs"))
	.sort();

let failed = 0;
let passed = 0;
const failures = [];

for (const file of files) {
	const result = spawnSync(process.execPath, [join("test", file)], {
		cwd: root,
		encoding: "utf8",
		timeout: timeoutMs,
	});
	const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	const pass = Number(out.match(/^ℹ pass (\d+)$/m)?.[1] ?? 0);
	const fail = Number(out.match(/^ℹ fail (\d+)$/m)?.[1] ?? 0);
	const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM";
	passed += pass;
	failed += fail;
	const bad = timedOut || fail > 0 || pass === 0 || result.status !== 0;
	if (bad) {
		failures.push({ file, pass, fail, timedOut, out });
		console.log(`✖ ${file}  pass=${pass} fail=${fail}${timedOut ? " TIMEOUT" : ""}`);
	} else {
		console.log(`✔ ${file}  pass=${pass}`);
	}
}

console.log(`\n${failures.length === 0 ? "ALL GREEN" : "FAILURES"} — ${passed} passed, ${failed} failed, ${files.length} files`);
if (failures.length > 0) {
	for (const item of failures) {
		console.log(`\n───── ${item.file} ─────`);
		console.log(item.out.split("\n").slice(-40).join("\n"));
	}
	process.exit(1);
}
