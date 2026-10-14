/**
 * SSH helpers for dsh-control.
 *
 * Everything the plugin needs from the remote machine travels over one SSH
 * call at a time (BatchMode: fail instead of prompting, because the plugin has
 * no terminal). Probes are combined into a single remote shell script so an
 * environment connect costs one round trip, not three.
 *
 * Portability (AGENTS.md #7): nothing here writes to the remote machine, and
 * every lookup that assumes a service manager has a fallback — a remote dsh may
 * run under systemd, tmux, nohup, docker, or anything else.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Run one command over SSH; never rejects, always resolves with code/stdout/stderr. */
export function runSsh(target, command, options = {}) {
	const { timeoutMs = 25_000, sshOptions = [] } = options;
	return new Promise((resolve) => {
		const args = [
			"-T",
			"-o", "BatchMode=yes",
			"-o", "StrictHostKeyChecking=accept-new",
			"-o", "ConnectTimeout=8",
			...sshOptions,
			target,
			command,
		];
		let child;
		try {
			child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			resolve({ code: -1, stdout: "", stderr: errorText(error) });
			return;
		}
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({ code: -1, stdout, stderr: `${stderr}\n(timeout after ${timeoutMs}ms)` });
		}, timeoutMs);
		child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
		child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
		child.on("error", (error) => finish({ code: -1, stdout, stderr: `${stderr}\n${errorText(error)}` }));
		child.on("close", (code) => finish({ code: code ?? -1, stdout, stderr }));
	});
}

/**
 * One round trip: is a dsh web process running, which systemd unit (if any)
 * owns it, and what did it print as the most recent `dsh web:` line?
 * Emits a small KEY-delimited report parsed by {@link parseRemoteReport}.
 */
export function buildProbeScript() {
	const findUnit = "systemctl list-units --type=service --all --no-legend 2>/dev/null | awk '/[Dd]eep[Ss]eek|[Dd][Ss][Hh]/{print $1; exit}'";
	const findProcess = 'ps -ef 2>/dev/null | grep -E "dsh.*web|bin[.]js.*web" | grep -v grep';
	return [
		'echo "PS_BEGIN"',
		findProcess,
		'echo "PS_END"',
		'echo "UNIT_BEGIN"',
		findUnit,
		'echo "UNIT_END"',
		'echo "LOG_BEGIN"',
		'line=""',
		// 1) the service manager's log, when there is one
		'unit=$(' + findUnit + ')',
		'[ -n "$unit" ] && line=$(journalctl -u "$unit" --no-pager -o cat 2>/dev/null | grep "dsh web:" | tail -1)',
		// 2) anywhere in the journal
		'[ -z "$line" ] && line=$(journalctl --no-pager -o cat 2>/dev/null | grep "dsh web:" | tail -1)',
		// 3) the process's own stdout, when it is a regular file (nohup / tmux redirect)
		'if [ -z "$line" ]; then',
		'  pid=$(' + findProcess + " | awk '{print $2}' | head -1)",
		'  if [ -n "$pid" ]; then',
		'    fd=$(readlink "/proc/$pid/fd/1" 2>/dev/null)',
		'    case "$fd" in /*) line=$(grep -a "dsh web:" "$fd" 2>/dev/null | tail -1);; esac',
		'  fi',
		'fi',
		// 4) the log files people usually end up with
		'[ -z "$line" ] && line=$(grep -a -h "dsh web:" "$HOME"/.dsh/*.log "$HOME"/nohup.out /var/log/dsh*.log 2>/dev/null | tail -1)',
		'printf "%s\\n" "$line"',
		'echo "LOG_END"',
		'',
	].join("\n");
}

/** Parse the report emitted by {@link buildProbeScript}. */
export function parseRemoteReport(stdout) {
	const section = (name) => {
		const match = stdout.match(new RegExp(`${name}_BEGIN\\n([\\s\\S]*?)\\n?${name}_END`));
		return match === null ? "" : match[1].trim();
	};
	const ps = section("PS");
	const unit = section("UNIT");
	const log = section("LOG");
	const process = parseWebProcess(ps);
	const token = parseTokenLine(log);
	return {
		process,
		unit: unit === "" ? undefined : unit,
		tokenLine: log === "" ? undefined : log,
		token: token?.token,
	};
}

/** Find the dsh web process line and its `--port`. */
export function parseWebProcess(psOutput) {
	for (const raw of String(psOutput ?? "").split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		if (!/\bweb\b/.test(line)) continue;
		if (!/dsh|bin\.js/.test(line)) continue;
		const port = line.match(/--port\s+(\d+)/)?.[1];
		const pid = line.split(/\s+/)[1];
		return { pid, port: port === undefined ? undefined : Number(port), line };
	}
	return undefined;
}

/** Extract the launch token from a `dsh web: http://…?token=…` line. */
export function parseTokenLine(line) {
	const match = String(line ?? "").match(/dsh web:\s*(\S*[?&]token=([A-Za-z0-9_-]{20,}))/);
	if (match === null) return undefined;
	return { url: match[1], token: match[2] };
}

/** Human-readable SSH failure hint for the common BatchMode rejections. */
export function sshFailureHint(stderr) {
	const text = String(stderr ?? "");
	if (/Permission denied/.test(text)) return "SSH 认证失败：这台服务器没有接受本机的密钥";
	if (/Host key verification failed/.test(text)) return "首次连接该服务器，主机指纹未被信任（先在终端手动 ssh 一次即可）";
	if (/Could not resolve hostname/.test(text)) return "无法解析这个服务器地址";
	if (/Connection (timed out|refused)/.test(text)) return "连不上这个服务器的 22 端口";
	if (/timeout after/.test(text)) return "SSH 命令超时";
	return text.trim() === "" ? "SSH 调用失败" : text.trim();
}

/** True when the failure is a rejected credential (as opposed to a network problem). */
export function isAuthFailure(stderr) {
	return /Permission denied|no supported authentication methods|publickey,password/i.test(String(stderr ?? ""));
}

/** First existing local public key, or undefined when the machine has none. */
export function defaultPublicKeyPath(candidates = DEFAULT_KEY_CANDIDATES) {
	for (const path of candidates) {
		try {
			if (existsSync(path)) return path;
		} catch { /* unreadable counts as absent */ }
	}
	return undefined;
}

const DEFAULT_KEY_CANDIDATES = [
	join(homedir(), ".ssh", "id_ed25519.pub"),
	join(homedir(), ".ssh", "id_ecdsa.pub"),
	join(homedir(), ".ssh", "id_rsa.pub"),
];

/**
 * The one-time fix for password-only servers: copy this machine's public key
 * over. Pure helper so the wording and commands stay testable.
 * @param target - `user@host` as the user typed it.
 * @param keyPath - existing public key, or undefined when none exists yet.
 */
export function buildAuthFix(target, keyPath) {
	if (keyPath === undefined) {
		return {
			label: "先在本机生成一把密钥，再把公钥装到服务器上",
			command: `ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 && ssh-copy-id -i ~/.ssh/id_ed25519.pub ${target}`,
		};
	}
	return {
		label: "在本机终端运行这一条，把公钥装到服务器上（只需一次）",
		command: `ssh-copy-id -i ${keyPath} ${target}`,
	};
}

function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}
