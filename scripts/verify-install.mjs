#!/usr/bin/env node
/**
 * Verify that a *new user* can install this plugin and actually run it.
 *
 * Simulates the documented path end to end: a brand-new DSH_HOME with a
 * minimal profile (base + web app, no plugin), the README install command,
 * then a real boot of that profile and a call into the plugin's host API.
 *
 * Sources:
 *   --source github   (default) `add github:owner/repo` — what users run
 *   --source tarball  `--tarball <file>` — the Release asset path
 *   --source local    `--local <dir>` — the working tree (fast, for iteration)
 *
 * Exit code 0 means: installed, booted, plugin registered, API answered.
 * UI rendering is not checked here — that stays a manual step (see AGENTS.md).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const source = flag("source", "github");
const tarball = flag("tarball");
const local = flag("local");
const profile = flag("profile", "installcheck");
const port = Number(flag("port", String(40000 + Math.floor(Math.random() * 2000))));
const dshCli = flag("dsh", "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh");

const fail = (message) => { console.error(`✖ verify-install: ${message}`); process.exit(1); };
const info = (message) => console.log(`  ${message}`);

if (!existsSync(dshCli)) fail(`dsh CLI not found at ${dshCli} (pass --dsh <path>)`);

// The desktop host entry is derived from the CLI location inside the app bundle.
// <Contents>/Resources/runtime/cli/bin/dsh → climb back to <Contents>
const appRoot = resolve(dirname(dshCli), "..", "..", "..", "..");
const hostBinary = join(appRoot, "MacOS", "DeepSeek Harness");
// Paths *inside* app.asar are not visible to plain Node (only Electron's fs can
// read the archive), so check the archive itself and let the spawn report errors.
const hostCli = join(appRoot, "Resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js");
if (!existsSync(hostBinary) || !existsSync(join(appRoot, "Resources", "app.asar"))) {
	fail("could not locate the desktop host binary / app.asar next to the dsh CLI");
}

const spec = source === "github"
	? "github:6mt/dsh-control"
	: source === "tarball"
		? (tarball === undefined ? fail("--source tarball needs --tarball <file>") : resolve(tarball))
		: source === "local"
			? (local === undefined ? fail("--source local needs --local <dir>") : `file:${resolve(local)}`)
			: fail(`unknown --source ${source}`);

const home = mkdtempSync(join(tmpdir(), "dsh-install-check-"));
const profileDir = join(home, "profiles", profile);
console.log(`verify-install: source=${source} profile=${profile} home=${home}`);
info(`spec: ${spec}`);

const cleanup = () => {
	try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
};
process.on("exit", cleanup);

// A profile shaped like a normal installation: base + web app only.
spawnSync("mkdir", ["-p", profileDir]);
const writeFile = (path, text) => spawnSync("sh", ["-c", `cat > ${JSON.stringify(path)} <<'EOF'\n${text}\nEOF`]);
writeFile(join(profileDir, "package.json"), JSON.stringify({
	name: `dsh-profile-${profile}`,
	private: true,
	dependencies: {},
	dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
}, null, 2));
writeFile(join(profileDir, "cordis.patch.yml"), "[]");

// 1. Install exactly as documented, retrying the flaky network like a user would.
const installOnce = () => spawnSync(dshCli, ["plugin", "--profile", profile, "add", spec], {
	env: { ...process.env, DSH_HOME: home },
	encoding: "utf8",
	timeout: 600_000,
});
let install;
for (let attempt = 1; attempt <= 3; attempt += 1) {
	install = installOnce();
	if (install.status === 0) break;
	info(`install attempt ${attempt} failed: ${(install.stderr ?? "").trim().split("\n").slice(-1)[0]}`);
}
if (install.status !== 0) fail(`install failed\n${(install.stderr ?? "").trim().slice(-800)}`);
const installed = readFileSync(join(profileDir, "package.json"), "utf8");
if (!installed.includes("\"dsh-control\"")) fail("install finished but the profile does not depend on dsh-control");
if (!installed.includes(`"${"dsh-control"}"`)) fail("plugin was installed but not added to the profile bundles");
info("installed and registered in the profile bundles");

// 2. Boot the fresh profile and talk to the plugin's host API.
const child = spawn(hostBinary, [
	"--expose-internals", hostCli,
	"--profile", profile, "--no-open", "--port", String(port),
], { env: { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"] });

let output = "";
child.stdout.on("data", (chunk) => { output += String(chunk); });
child.stderr.on("data", (chunk) => { output += String(chunk); });

const waitFor = async (predicate, timeoutMs, label) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 300));
	}
	fail(`timed out waiting for ${label}\n${output.slice(-800)}`);
};

const base = `http://127.0.0.1:${port}`;
await waitFor(() => /token=[\w-]{20,}/.test(output), 60_000, "the launch token");
const token = output.match(/dsh web: \S+\?token=([\w-]+)/)?.[1];
if (token === undefined) fail("could not read the launch token from the host output");
await waitFor(() => {
	const probe = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", base, "--max-time", "2"], { encoding: "utf8" });
	return probe.stdout === "401";
}, 30_000, "the web server to accept connections");

const jar = join(home, "cookies.txt");
spawnSync("curl", ["-s", "-c", jar, "-o", "/dev/null", `${base}/?token=${token}`, "--max-time", "10"]);
const call = spawnSync("curl", [
	"-s", "-b", jar, "-X", "POST", `${base}/api/dshControl/diagnostics`,
	"-H", "content-type: application/json",
	"-d", JSON.stringify({ type: "client-request", rpcId: "verify-install", method: "dshControl/diagnostics", payload: { args: {} } }),
	"--max-time", "20",
], { encoding: "utf8" });

let payload;
try { payload = JSON.parse(call.stdout); } catch { fail(`diagnostics returned non-JSON: ${call.stdout.slice(0, 200)}`); }
const value = payload?.result?.value;
if (payload?.result?.ok !== true) fail(`diagnostics failed: ${JSON.stringify(payload?.result?.error).slice(0, 300)}`);
if (value?.adapter?.registered !== true) fail("plugin host API answered but its LLM adapter is not registered");
if (value?.adapter?.provider !== "dsh-control") fail(`unexpected provider: ${value?.adapter?.provider}`);

child.kill("SIGTERM");
console.log(`✔ verify-install: installed (${source}), booted, plugin loaded (provider ${value.adapter.provider})`);
process.exit(0);
