/**
 * dsh-control remote connection manager (host side).
 *
 * One RemoteDsh per configured host. Speaks the dsh web connection protocol
 * verified in research/05-step0-verification.md:
 *   POST {endpoint}/api/<namespace>/<method>
 *   body: {"type":"client-request","rpcId":<id>,"method":"<ns>/<method>","payload":{"args":{...}}}
 *   response: {"type":"server-response","rpcId":<id>,"result":{"ok":true,"value":...}|{"ok":false,"error":{...}}}
 * Auth: launch token -> GET /?token=... -> authority-bound signed cookie (30d),
 * replayed as a Cookie header on every /api call. 401 triggers one cookie refresh.
 */

const CONNECT_TIMEOUT_MS = 8_000;
const CALL_TIMEOUT_MS = 20_000;

export class RemoteDsh {
	/**
	 * @param {{name: string, endpoint: string, token: string, authHeader?: string}} spec
	 * authHeader: optional "Authorization: Basic …" for a reverse-proxy gate in front of dsh.
	 */
	constructor(spec) {
		this.name = spec.name;
		this.endpoint = spec.endpoint.replace(/\/+$/, "");
		this.token = spec.token;
		this.authHeader = typeof spec.authHeader === "string" && spec.authHeader !== ""
			? spec.authHeader
			: undefined;
		this.cookie = undefined;
		this.cookieName = undefined;
		this.lastStatus = "unknown"; // unknown | connected | unreachable | unauthenticated | error
		this.lastDetail = undefined;
		this.lastCheckedAt = undefined;
	}

	/** Headers every request carries (proxy gate + dsh cookie once known). */
	requestHeaders() {
		const headers = {};
		if (this.authHeader !== undefined) headers.authorization = this.authHeader;
		if (this.cookieName !== undefined && this.cookie !== undefined) {
			headers.cookie = `${this.cookieName}=${this.cookie}`;
		}
		return headers;
	}

	/** Exchange the launch token for a signed session cookie. */
	async ensureCookie(signal) {
		const response = await fetch(`${this.endpoint}/?token=${encodeURIComponent(this.token)}`, {
			redirect: "manual",
			signal: signal ?? AbortSignal.timeout(CONNECT_TIMEOUT_MS),
			headers: this.authHeader !== undefined ? { authorization: this.authHeader } : {},
		});
		const cookies = response.headers.getSetCookie?.() ?? [];
		for (const line of cookies) {
			const pair = line.split(";", 1)[0];
			const eq = pair.indexOf("=");
			if (eq > 0 && pair.slice(0, eq).startsWith("dsh-auth-")) {
				this.cookieName = pair.slice(0, eq);
				this.cookie = pair.slice(eq + 1);
				return true;
			}
		}
		// A valid existing cookie answers 303 without set-cookie only when already
		// authenticated — but dsh always re-mints; treat absence as auth failure.
		if (response.status === 303) return this.cookie !== undefined;
		if (response.status === 401) {
			this.lastStatus = "unauthenticated";
			this.lastDetail = "token 被拒绝（远程实例可能已重启并更换了 token，请在面板重新粘贴新连接块）";
			return false;
		}
		this.lastStatus = "error";
		this.lastDetail = `token 交换得到 HTTP ${response.status}`;
		return false;
	}

	/**
	 * Invoke one remote gateway method.
	 * @param {string} methodPath "session/list" style
	 * @param {Record<string, unknown>} args named arguments
	 * @returns {Promise<{ok: true, value: unknown} | {ok: false, error: {code: string, message: string}}>}
	 */
	async call(methodPath, args = {}) {
		if (this.cookie === undefined) {
			const fresh = await this.ensureCookie().catch((error) => {
				this.lastStatus = "unreachable";
				this.lastDetail = `隧道未建立或实例不可达：${errorText(error)}`;
				return false;
			});
			if (!fresh) {
				return { ok: false, error: { code: "dsh-control/auth", message: this.lastDetail ?? "鉴权失败" } };
			}
		}
		let result = await this.post(methodPath, args);
		if (result.ok === false && result.error?.code === "dsh-control/unauthorized") {
			// cookie expired / instance restarted: refresh once and retry
			this.cookie = undefined;
			const fresh = await this.ensureCookie().catch(() => false);
			if (!fresh) {
				return { ok: false, error: { code: "dsh-control/auth", message: this.lastDetail ?? "鉴权失败" } };
			}
			result = await this.post(methodPath, args);
		}
		return result;
	}

	async post(methodPath, args) {
		const rpcId = `dshctl-${crypto.randomUUID()}`;
		const headers = { "content-type": "application/json", ...this.requestHeaders() };
		let response;
		try {
			response = await fetch(`${this.endpoint}/api/${methodPath}`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					type: "client-request",
					rpcId,
					method: methodPath,
					payload: { args },
				}),
				signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
			});
		} catch (error) {
			this.lastStatus = "unreachable";
			this.lastDetail = `请求失败：${errorText(error)}`;
			return { ok: false, error: { code: "dsh-control/unreachable", message: this.lastDetail } };
		}
		if (response.status === 401) {
			return { ok: false, error: { code: "dsh-control/unauthorized", message: "cookie 失效" } };
		}
		if (!response.ok) {
			this.lastStatus = "error";
			this.lastDetail = `HTTP ${response.status}`;
			return { ok: false, error: { code: "dsh-control/http", message: `HTTP ${response.status}` } };
		}
		const envelope = await response.json().catch(() => undefined);
		const result = envelope?.result ?? envelope;
		if (result?.ok === true) {
			this.markConnected();
			return { ok: true, value: result.value };
		}
		const message = result?.error?.message ?? "远程网关返回未知错误";
		this.lastStatus = "error";
		this.lastDetail = message;
		return { ok: false, error: { code: result?.error?.code ?? "dsh-control/remote", message } };
	}

	/** Probe + list sessions; updates status fields. */
	async sessions() {
		const result = await this.call("session/list", { _request: {} });
		if (result.ok === false) return result;
		const items = (result.value?.items ?? []).map(mapSession);
		return { ok: true, value: { items } };
	}

	/**
	 * Follow one remote Session as a live stream (WebSocket mux).
	 * @param request - the `session/follow` request body.
	 * @returns an async iterator of follow frames.
	 */
	async *follow(request, options = {}) {
		if (this.cookie === undefined) {
			const fresh = await this.ensureCookie().catch(() => false);
			if (!fresh) throw new Error(this.lastDetail ?? "鉴权失败");
		}
		const { openRemoteStream } = await import("./mux.js");
		// Node's built-in WebSocket accepts a headers option, carrying both the
		// proxy gate's Authorization and dsh's cookie on the upgrade handshake.
		const wsHeaders = {};
		if (this.authHeader !== undefined) wsHeaders.authorization = this.authHeader;
		if (this.cookieName !== undefined) wsHeaders.cookie = `${this.cookieName}=${this.cookie}`;
		yield* openRemoteStream({
			url: `${this.endpoint.replace(/^http/, "ws")}/api/remote.mux`,
			cookie: `${this.cookieName}=${this.cookie}`,
			endpoint: "session/follow",
			args: { request },
			signal: options.signal,
			extraHeaders: wsHeaders,
		});
	}

	markConnected() {
		this.lastStatus = "connected";
		this.lastDetail = undefined;
		this.lastCheckedAt = Date.now();
	}
}

function mapSession(item) {
	const projections = item.projections?.values;
	return {
		sessionId: item.sessionId,
		title: projections?.title ?? null,
		cwd: item.cwd ?? null,
		running: item.running === true,
		blank: item.blank === true,
		agentAvailable: item.agentAvailable === true,
		updatedAt: item.updatedAt ?? null,
		turns: projections?.sessionStats?.turns ?? null,
		goal: projections?.goal ?? null,
	};
}

function errorText(error) {
	if (error instanceof Error) {
		if (error.name === "TimeoutError") return "连接超时";
		if (error.cause?.code === "ECONNREFUSED") return "连接被拒绝（本地隧道未启动？）";
		return error.message;
	}
	return String(error);
}
