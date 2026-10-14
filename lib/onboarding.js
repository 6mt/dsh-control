/**
 * dsh-control onboarding material.
 *
 * Design: the user copies twice and pastes twice, and never sees a port.
 *   1. The UI generates an SSH tunnel command (run in a local terminal) and a
 *      self-contained paragraph (pasted into a session of the REMOTE dsh,
 *      which the user reaches through that tunnel).
 *   2. The remote dsh checks or installs its own web service, reads its launch
 *      token, and prints a `dshctl-connect` block.
 *   3. The user pastes that block back; this module parses it.
 */

/** Derive a friendly default environment name from `[user@]host[:port]`. */
export function suggestName(sshTarget) {
	if (typeof sshTarget !== "string") return "remote";
	const withoutUser = sshTarget.includes("@") ? sshTarget.slice(sshTarget.indexOf("@") + 1) : sshTarget;
	const host = withoutUser.split(":")[0].trim();
	const cleaned = host.replace(/[^\w.-]/g, "-").replace(/^[.-]+|[.-]+$/g, "");
	return cleaned === "" ? "remote" : cleaned;
}

/** Build the SSH tunnel command the user runs locally. */
export function buildTunnelCommand(spec) {
	const { sshTarget, localPort, remotePort } = spec;
	return `ssh -N -L 127.0.0.1:${localPort}:127.0.0.1:${remotePort} ${sshTarget}`;
}

/** Build the self-contained paragraph the user pastes into the remote dsh session. */
export function buildRemoteParagraph(spec) {
	return [
		"请帮我取一下本机 dsh 的访问令牌，只需要回复令牌本身：",
		"",
		"1. 如果本机有 dsh 在运行，从它的启动日志里找最近一次打印的 `dsh web: http://...?token=...`：",
		'   例如：journalctl -u <服务名> --no-pager -o cat | grep "dsh web:" | tail -1',
		"   日志里找不到，就重新启动一次，让它重新打印。",
		"2. 如果本机没有在运行的 dsh，先启动一个 dsh web，然后回到第 1 步。",
		"3. 只回复下面这个块，token 保持完整不要打码：",
		"",
		"```dshctl-token",
		"<token>",
		"```",
	].join("\n");
}

/**
 * Parse the pasted connect block into an environment draft.
 * Tolerant: accepts the fenced block, a JSON object, a URL with ?token=, or a bare token.
 * @returns normalised fields, or `{ error }` when nothing usable was found.
 */
export function parseConnectBlock(text, fallback = {}) {
	if (typeof text !== "string" || text.trim() === "") return { error: "粘贴内容为空" };
	const trimmed = text.trim();

	const fence = trimmed.match(/```[a-z-]*(?:dshctl-(?:connect|token))?[a-z-]*\s*\n([\s\S]*?)```/i);
	if (fence) {
		const fields = {};
		for (const line of fence[1].split("\n")) {
			const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]\s*(.+?)\s*$/);
			if (match) fields[match[1].toLowerCase().replace(/-/g, "_")] = match[2];
		}
		// The minimal `dshctl-token` block carries the token alone, with no fields.
		if (Object.keys(fields).length === 0) {
			const bare = fence[1].trim();
			if (/^[A-Za-z0-9_-]{20,}$/.test(bare)) return normalizeFields({ token: bare }, fallback);
		}
		return normalizeFields(fields, fallback);
	}

	if (trimmed.startsWith("{")) {
		try {
			return normalizeFields(JSON.parse(trimmed), fallback);
		} catch {
			return { error: "这段内容看起来是 JSON，但解析失败了" };
		}
	}

	// A URL carrying ?token= — take both the address and the token from it.
	const urlToken = trimmed.match(/[?&]token=([A-Za-z0-9_-]{20,})/)?.[1];
	if (urlToken !== undefined) {
		let endpoint = fallback.endpoint;
		try {
			endpoint = new URL(trimmed).origin;
		} catch { /* not an absolute URL — keep the fallback address */ }
		return normalizeFields({ token: urlToken, endpoint }, fallback);
	}

	// A bare token.
	if (/^[A-Za-z0-9_-]{20,}$/.test(trimmed)) return normalizeFields({ token: trimmed }, fallback);

	return { error: "没认出这段内容。请粘贴远端会话输出的 dshctl-connect 块（或整个带 token 的地址）" };
}

function normalizeFields(fields, fallback) {
	const token = fields.token ?? fallback.token;
	if (token === undefined || token === "" || String(token).includes("<")) {
		return { error: "缺少有效的 token。请让远端 dsh 重新输出连接块（第 3-4 步）" };
	}
	return {
		name: fields.name ?? fallback.name,
		endpoint: stripTrailingSlash(fields.endpoint ?? fallback.endpoint),
		token: String(token),
		remotePort: numberOr(fields.remote_port ?? fields.remotePort, fallback.remotePort),
		localPort: numberOr(fields.local_port ?? fields.localPort, fallback.localPort),
	};
}

function numberOr(value, fallbackValue) {
	const n = Number(value);
	return Number.isSafeInteger(n) && n > 0 ? n : fallbackValue;
}

function stripTrailingSlash(url) {
	return typeof url === "string" ? url.replace(/\/+$/, "") : url;
}
