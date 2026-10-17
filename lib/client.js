/**
 * dsh-control client (browser) entry — the "远程 dsh 环境" panel.
 *
 * Product flow: type `user@host`, press 连接. The host half probes the remote
 * machine over SSH, reads its access token, opens and keeps the channel, then
 * verifies — the user never types a port or an address. Manual copy-paste steps
 * remain available on demand when automation cannot run.
 *
 * UI rules:
 *   - build the panel from the official primitives (Button/Input/StateDot/
 *     DisclosureRow/Tag) and the shared CSS design tokens;
 *   - the guide capsule is rendered by the sidebar itself, so this bundle
 *     registers ONLY the tab type plus the pane body/title slots —
 *     registering into "sidebar.right.tab.guide.entry" would replace the
 *     sidebar's clickable capsule and break opening the tab;
 *   - host calls go through the connection RPC channel
 *     (POST /api/dshControl/<method>), no generated descriptors needed.
 */
window.__ModuleLoader__.load({
	id: "dsh-control",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const h = react.createElement;
		const { useState, useEffect, useCallback, useRef } = react;
		const {
			Button, Input, StateDot, DisclosureRow, Tag,
			IconPlusOutlineRegular, IconRefreshOutlineRegular,
			IconTrashOutlineRegular, IconRightUpOutlineRegular, IconCopyOutlineRegular,
			IconGlobeOutlineRegular,
		} = primitives;

		const TAB_ID = "dsh-control";
		const NS = "dshControl";

		/** Connection status -> StateDot state + human label. */
		const STATUS = {
			connected: { dot: "done", label: "已连接" },
			unreachable: { dot: "error", label: "已断开" },
			unauthenticated: { dot: "warning", label: "需要重新接入" },
			error: { dot: "warning", label: "异常" },
			unknown: { dot: "idle", label: "未检测" },
		};

		// ---------- interaction decisions (pure, unit-tested) ----------

		/**
		 * Normalise a `connect` answer into what the panel shows, so every failure
		 * path carries the actions the user needs (retry / fix command / manual).
		 */
		function noticeFromConnectResult(result) {
			const value = result?.ok === true
				? (result.value ?? {})
				: { error: result?.error?.message };
		const cleaned = result?.ok === true && value.error === undefined
			&& (value.workspaceError === undefined || value.workspaceError === "");
		if (cleaned) return undefined;
		if (result?.ok === true && typeof value.workspaceError === "string" && value.workspaceError !== "") {
			// Connected is not the whole job: without its Workspace the environment
			// has nowhere to live in the sidebar, and that must never be silent.
			return {
				tone: "error",
				text: `已连接，但工作区没有建成：${value.workspaceError}`,
				retry: true,
			};
		}
			return {
				tone: "error",
				// Never render a blank notice: a failure the host did not describe
				// still has to tell the user something.
				text: typeof value.error === "string" && value.error !== "" ? value.error : "连接失败",
				detail: value.detail,
				fix: value.fix,
				manual: value.manual === true,
				retry: value.retry === true,
			};
		}

		/** Status dot + label for one environment row; missing credentials win over the probe. */
		function statusOf(environment) {
			const status = STATUS[environment?.status] ?? STATUS.unknown;
			return {
				dot: environment?.ready === false ? "warning" : status.dot,
				label: status.label,
			};
		}

		/** Disconnected environments offer「重连」; connected ones do not. */
		function needsReconnect(environment) {
			return environment?.status !== "connected";
		}

		/** One-line summary shown next to the environment name. */
		function environmentSummary(environment) {
			const status = STATUS[environment?.status] ?? STATUS.unknown;
			const place = environment?.workspace == null ? "无工作区" : "已有工作区";
			return [status.label, environment?.sshTarget ?? environment?.endpoint ?? "", place].filter(Boolean).join(" · ");
		}

		/** Design tokens shared with the rest of the product. */
		const INK = "var(--dsw-alias-label-primary)";
		const INK_SUB = "var(--dsw-alias-label-tertiary)";
		const LINE = "var(--dsw-alias-border-l3)";
		const LAYER = "var(--dsw-alias-bg-layer-1)";
		const DANGER = "var(--dsw-alias-state-error, #d14343)";
		const OK = "var(--dsw-alias-state-success, #2f9e59)";

		/**
		 * Injected stylesheet: the official Input renders a wrapper around the
		 * <input>, so an inline width on the input alone cannot stretch the row.
		 * Official plugins inject a tagged <style> element the same way.
		 */
		const CSS_TAG = "dsh-control/panel.css";
		const CSS = [
			".dshctl-field{width:100%;display:block;box-sizing:border-box}",
			".dshctl-field input{width:100%;box-sizing:border-box}",
		].join("");
		if (typeof document !== "undefined" && document.querySelector(`style[data-plugin=${JSON.stringify(CSS_TAG)}]`) === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = CSS_TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ---------- helpers ----------

		function makeApi(ctx) {
			return async function call(method, args) {
				const connection = ctx.get ? ctx.get("connection") : ctx.connection;
				const rpc = connection?.rpc;
				if (rpc === undefined || typeof rpc.call !== "function") {
					return { ok: false, error: { message: "连接服务不可用，请在 dsh 界面中打开本面板" } };
				}
				try {
					const result = await rpc.call("/api", `${NS}/${method}`, { args: args ?? {} });
					if (result?.ok === true) return { ok: true, value: result.value };
					return { ok: false, error: result?.error ?? { message: "未知错误" } };
				} catch (error) {
					const message = String(error?.message ?? error);
					// The interface half of a plugin can update while the running host
					// still has the previous host half in memory: an endpoint the host
					// never registered answers 404. Say what to do about it.
					if (/HTTP\s*404/.test(message)) {
						return { ok: false, error: { message: "当前运行中的 dsh 仍是旧版插件。请完全退出 dsh（⌘Q）再重新打开，然后重试。" } };
					}
					return { ok: false, error: { message: `调用失败：${message}` } };
				}
			};
		}

		function copyText(text) {
			try {
				navigator.clipboard?.writeText(text);
			} catch { /* clipboard unavailable */ }
		}

		function fmtTime(ms) {
			if (typeof ms !== "number") return "";
			try {
				const delta = Date.now() - ms;
				if (delta < 60_000) return "刚刚";
				if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
				if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
				return new Date(ms).toLocaleDateString();
			} catch {
				return "";
			}
		}

		// ---------- shared pieces ----------

		/** A labelled, copyable text block (tunnel command / remote request). */
		function CopyBlock({ hint, text, mono }) {
			return h("div", { style: { marginTop: 6 } },
				h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 4 } },
					hint !== undefined && h("span", { style: { fontSize: 11, color: INK_SUB, flex: 1 } }, hint),
					h(Button, {
						size: "sm",
						variant: "outline",
						icon: h(IconCopyOutlineRegular, { size: 13 }),
						onClick: () => copyText(text),
					}, "复制")),
				h("pre", {
					style: {
						margin: 0, padding: "8px 10px", fontSize: 11, lineHeight: 1.55,
						fontFamily: mono === true ? "ui-monospace, SFMono-Regular, Menlo, monospace" : "inherit",
						whiteSpace: "pre-wrap", wordBreak: "break-word",
						background: LAYER, border: `0.5px solid ${LINE}`,
						borderRadius: 10, maxHeight: 190, overflow: "auto", color: INK,
					},
				}, text));
		}

		function Notice({ tone, children }) {
			const color = tone === "error" ? DANGER : tone === "success" ? OK : INK_SUB;
			return h("div", { style: { marginTop: 8, fontSize: 12, color, lineHeight: 1.6 } }, children);
		}

		function Step({ index, title, children }) {
			return h("div", { style: { marginTop: 12 } },
				h("div", { style: { display: "flex", gap: 8, alignItems: "baseline" } },
					h("span", {
						style: {
							fontSize: 11, color: INK_SUB, border: `0.5px solid ${LINE}`,
							borderRadius: 999, width: 18, height: 18, lineHeight: "17px",
							textAlign: "center", flex: "none",
						},
					}, String(index)),
					h("span", { style: { fontSize: 12, fontWeight: 600, color: INK } }, title)),
				h("div", { style: { marginLeft: 26 } }, children));
		}

		/** Sessions of one environment, rendered inside its expanded row. */
		/**
		 * One remote conversation inside the 远程环境 page: history (cold read),
		 * a live poll while the remote turn runs, and a take-over input.
		 */
		function RemoteConversation({ api, environment, session, onChanged }) {
			const [history, setHistory] = useState(undefined);
			const [sending, setSending] = useState(false);
			const [input, setInput] = useState("");
			const [error, setError] = useState(null);
			const scrollRef = useRef(null);

			const load = useCallback(async () => {
				const result = await api("sessionHistory", { environment, remoteSessionId: session.sessionId });
				setHistory(result.ok === true ? result.value : { error: result.error?.message ?? "读取失败" });
			}, [environment, session.sessionId]);

			useEffect(() => { setHistory(undefined); setError(null); load(); }, [load]);
			useEffect(() => {
				const node = scrollRef.current;
				if (node !== null) node.scrollTop = node.scrollHeight;
			}, [history]);
			// While the remote turn runs, poll so new messages appear without a click.
			useEffect(() => {
				if (session.running !== true) return;
				const timer = setInterval(load, 4000);
				return () => clearInterval(timer);
			}, [session.running, load]);

			const send = useCallback(async () => {
				const text = input.trim();
				if (text === "" || sending || session.running) return;
				setSending(true); setError(null);
				const result = await api("sendToSession", { environment, remoteSessionId: session.sessionId, text });
				setSending(false);
				if (result.ok === false) { setError(result.error?.message ?? "发送失败"); return; }
				setInput("");
				await load();
				if (typeof onChanged === "function") onChanged();
			}, [input, sending, session, environment, load, onChanged]);

			const items = Array.isArray(history?.items) ? history.items : [];
			return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } },
				h("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", borderBottom: `0.5px solid ${LINE}`, flex: "none" } },
					h(StateDot, { state: session.running ? "ongoing" : "done", size: 8 }),
					h("span", { style: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: INK, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
						session.title ?? session.sessionId.slice(0, 24))),
				h("div", { ref: scrollRef, style: { flex: 1, minHeight: 0, overflow: "auto", padding: 12, display: "grid", gap: 8, alignContent: "start" } },
					history === undefined && h("span", { style: { fontSize: 12, color: INK_SUB } }, "正在读取对话…"),
					history?.error !== undefined && h("span", { style: { fontSize: 12, color: DANGER } }, history.error),
					items.length === 0 && history?.error === undefined && h("span", { style: { fontSize: 12, color: INK_SUB } }, "这个会话还没有消息"),
					items.map((msg, index) =>
					h("div", {
						key: index,
						style: {
							fontSize: 12, lineHeight: 1.7, padding: "8px 12px", borderRadius: 10, maxWidth: "88%",
							justifySelf: msg.role === "user" ? "end" : "start",
							background: msg.role === "user" ? "rgba(31,111,235,0.10)" : "rgba(127,127,127,0.06)",
							whiteSpace: "pre-wrap", wordBreak: "break-word", color: INK,
						},
					}, msg.text))),
				(error !== null || session.running === true) && h("div", { style: { padding: "4px 12px", fontSize: 11, color: session.running === true ? INK_SUB : DANGER, flex: "none" } },
					error ?? "远端正在运行，回复会自动出现…"),
				h("div", { style: { display: "flex", gap: 6, padding: 10, borderTop: `0.5px solid ${LINE}`, flex: "none" } },
					h(Input, {
						className: "dshctl-field",
						value: input,
						placeholder: session.running ? "远端正在运行，等它结束…" : "以「控制端」身份发到远端会话…",
						disabled: session.running === true || sending,
						onChange: (event) => setInput(event.target.value),
						onKeyDown: (event) => { if (event.key === "Enter") send(); },
					}),
					h(Button, {
						size: "sm", variant: "primary",
						disabled: input.trim() === "" || sending || session.running === true,
						onClick: send,
					}, sending ? "发送中…" : "发送")));
		}

		function SessionList({ state }) {
			if (state === undefined) {
				return h("div", { style: { fontSize: 12, color: INK_SUB, padding: "6px 0" } }, "正在读取会话…");
			}
			if (state.ok === false) {
				return h("div", { style: { fontSize: 12, color: DANGER, padding: "6px 0" } }, state.error.message);
			}
			const items = state.value.items;
			if (items.length === 0) {
				return h("div", { style: { fontSize: 12, color: INK_SUB, padding: "6px 0" } }, "这个环境里还没有会话");
			}
			return h("div", { style: { padding: "4px 0" } }, items.map((session) =>
				h("div", {
					key: session.sessionId,
					style: { display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderRadius: 8 },
				},
					h(StateDot, { state: session.running ? "ongoing" : "idle", size: 8 }),
					h("span", {
						style: { flex: 1, minWidth: 0, fontSize: 12, color: INK, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
						title: `${session.title ?? session.sessionId}\n${session.cwd ?? ""}`,
					}, session.title ?? session.sessionId.slice(0, 24)),
					session.running === true && h(Tag, { tone: "outline" }, "运行中"),
					h("span", { style: { fontSize: 11, color: INK_SUB, flex: "none" } }, fmtTime(session.updatedAt)))));
		}

		// ---------- add environment ----------

		function AddEnvironment({ api, onDone, onClose }) {
			const [name, setName] = useState("");
			const [sshTarget, setSshTarget] = useState("");
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState(null);
			const [manual, setManual] = useState(null);
			const [manualBusy, setManualBusy] = useState(false);
			const [paste, setPaste] = useState("");
			const [mode, setMode] = useState("ssh"); // "ssh" | "direct"
			const [directUrl, setDirectUrl] = useState("");
			const [directToken, setDirectToken] = useState("");
			const [authUser, setAuthUser] = useState("");
			const [authPassword, setAuthPassword] = useState("");

			const connectDirect = useCallback(async () => {
				setBusy(true); setNotice(null);
				const result = await api("adoptDirect", {
					endpoint: directUrl.trim(),
					token: directToken.trim(),
					name: name.trim(),
					authUser: authUser.trim() || undefined,
					authPassword: authPassword || undefined,
				});
				setBusy(false);
				const notice = noticeFromConnectResult(result);
				if (notice === undefined) {
					onDone(`已连接「${result.value.name}」，发现 ${result.value.sessions ?? 0} 个会话`);
					return;
				}
				setNotice(notice);
			}, [directUrl, directToken, name, authUser, authPassword]);

			const connect = useCallback(async () => {
				setBusy(true);
				setNotice(null);
				setManual(null);
				const result = await api("connect", { sshTarget: sshTarget.trim(), name: name.trim() });
				setBusy(false);
				const notice = noticeFromConnectResult(result);
				if (notice === undefined) {
					onDone(`已连接「${result.value.name}」，发现 ${result.value.sessions ?? 0} 个会话`);
					return;
				}
				setNotice(notice);
			}, [sshTarget, name]);

			const loadManual = useCallback(async () => {
				setManualBusy(true);
				const result = await api("setupSteps", { sshTarget: sshTarget.trim(), name: name.trim() });
				setManualBusy(false);
				if (result.ok === false) { setNotice({ tone: "error", text: result.error.message }); return; }
				if (result.value.error !== undefined) { setNotice({ tone: "error", text: result.value.error }); return; }
				setManual(result.value);
			}, [sshTarget, name]);

			const finishManual = useCallback(async () => {
				setManualBusy(true);
				const result = await api("adopt", {
					input: paste,
					name: name.trim(),
					sshTarget: sshTarget.trim(),
					localPort: manual?.localPort,
					remotePort: manual?.remotePort,
				});
				setManualBusy(false);
				if (result.ok === false) { setNotice({ tone: "error", text: result.error.message }); return; }
				if (result.value.error !== undefined) { setNotice({ tone: "error", text: result.value.error }); return; }
				const notice = noticeFromConnectResult(result);
				if (notice !== undefined) { setNotice(notice); return; }
				onDone(`已连接「${result.value.name}」，发现 ${result.value.sessions ?? 0} 个会话`);
			}, [paste, name, sshTarget, manual]);

			const modeChip = (label, active, hint) =>
				h("span", {
					key: label,
					style: {
						display: "inline-flex", alignItems: "center", gap: 3,
						padding: "3px 10px", borderRadius: 999, fontSize: 11,
						border: `0.5px solid ${active ? LINE : "transparent"}`,
						color: active ? INK : INK_SUB,
						background: active ? "rgba(127,127,127,0.10)" : "transparent",
						opacity: active ? 1 : 0.65,
						cursor: "pointer",
					},
					onClick: active ? () => { setMode(label === "SSH" ? "ssh" : "direct"); setNotice(null); } : undefined,
				}, label, hint !== undefined && h("span", { style: { fontSize: 10 } }, hint));

			return h("div", {
				style: { margin: "10px 0", padding: 12, border: `0.5px solid ${LINE}`, borderRadius: 12, background: LAYER },
			},
				h("div", { style: { display: "flex", alignItems: "center" } },
					h("span", { style: { flex: 1, fontSize: 13, fontWeight: 600, color: INK } }, "添加远程环境"),
					h(Button, { size: "sm", variant: "ghost", onClick: onClose }, "取消")),

				h("div", { style: { marginTop: 10, display: "flex", gap: 6, alignItems: "center" } },
					modeChip("SSH", mode === "ssh"),
					modeChip("直接地址", false, "· 即将开放")),

				mode === "ssh" ? h("div", { style: { marginTop: 10, display: "grid", gap: 8 } },
					h("label", null,
						h("div", { style: { fontSize: 11, color: INK_SUB, marginBottom: 4 } }, "名称（可留空，自动取服务器地址）"),
						h(Input, {
							className: "dshctl-field",
							value: name,
							placeholder: "例如：公司测试机",
							onChange: (event) => setName(event.target.value),
						})),
					h("label", null,
						h("div", { style: { fontSize: 11, color: INK_SUB, marginBottom: 4 } }, "服务器"),
						h(Input, {
							className: "dshctl-field",
							value: sshTarget,
							placeholder: "user@host，例如 root@10.0.0.5",
							onChange: (event) => setSshTarget(event.target.value),
							onKeyDown: (event) => {
								if (event.key === "Enter" && sshTarget.trim() !== "" && !busy) connect();
							},
						}))) : h("div", { style: { marginTop: 10, display: "grid", gap: 8 } },
					h("label", null,
						h("div", { style: { fontSize: 11, color: INK_SUB, marginBottom: 4 } }, "名称（可留空，自动取域名）"),
						h(Input, {
							className: "dshctl-field",
							value: name,
							placeholder: "例如：cn-dsh2",
							onChange: (event) => setName(event.target.value),
						})),
					h("label", null,
						h("div", { style: { fontSize: 11, color: INK_SUB, marginBottom: 4 } }, "地址"),
						h(Input, {
							className: "dshctl-field",
							value: directUrl,
							placeholder: "https://example.com",
							onChange: (event) => setDirectUrl(event.target.value),
						})),
					h("label", null,
						h("div", { style: { fontSize: 11, color: INK_SUB, marginBottom: 4 } }, "访问令牌（远端 dsh 启动输出里 ?token= 后面那串）"),
						h(Input, {
							className: "dshctl-field",
							value: directToken,
							placeholder: "粘贴令牌",
							onChange: (event) => setDirectToken(event.target.value),
						})),
					h("details", { style: { marginTop: 2 } },
						h("summary", { style: { fontSize: 11, color: INK_SUB, cursor: "pointer" } }, "域名前面有 Basic Auth？（可选）"),
						h("div", { style: { marginTop: 8, display: "grid", gap: 8 } },
							h("label", null,
								h("div", { style: { fontSize: 11, color: INK_SUB, marginBottom: 4 } }, "用户名"),
								h(Input, {
									className: "dshctl-field",
									value: authUser,
									placeholder: "反代/网关的用户名",
									onChange: (event) => setAuthUser(event.target.value),
								})),
							h("label", null,
								h("div", { style: { fontSize: 11, color: INK_SUB, marginBottom: 4 } }, "密码"),
								h(Input, {
									className: "dshctl-field", type: "password",
									value: authPassword,
									placeholder: "反代/网关的密码",
									onChange: (event) => setAuthPassword(event.target.value),
								}))))),

				h("div", { style: { marginTop: 10, display: "flex", alignItems: "center", gap: 8 } },
					mode === "ssh"
						? h(Button, {
							size: "sm",
							variant: "primary",
							disabled: busy || sshTarget.trim() === "",
							onClick: connect,
						}, busy ? "连接中…" : "连接")
						: h(Button, {
							size: "sm",
							variant: "primary",
							disabled: busy || directUrl.trim() === "" || directToken.trim() === "",
							onClick: connectDirect,
						}, busy ? "连接中…" : "连接"),
					mode === "ssh" && busy && h("span", { style: { fontSize: 11, color: INK_SUB } }, "正在通过 SSH 检查这台机器，通常几秒钟")),

				mode === "ssh" && h("div", { style: { marginTop: 8, fontSize: 11, color: INK_SUB, lineHeight: 1.6 } },
					"需要本机能免密登录这台服务器；没有的话，连接时会给出配置命令。"),

				mode === "direct" && h("div", { style: { marginTop: 8, fontSize: 11, color: INK_SUB, lineHeight: 1.6 } },
					"远端 dsh 重启后令牌会变，届时重新粘贴一次即可。"),

				notice !== null && h(Notice, { tone: notice.tone },
					notice.text,
					notice.detail !== undefined && h("div", { style: { marginTop: 2 } }, notice.detail),
					notice.fix !== undefined && h(CopyBlock, { hint: notice.fix.label, text: notice.fix.command, mono: true }),
					h("div", { style: { marginTop: 6, display: "flex", gap: 6 } },
						notice.retry === true && h(Button, {
							size: "sm", variant: "outline", disabled: busy,
							onClick: mode === "direct" ? connectDirect : connect,
						}, "重试"),
						notice.manual === true && mode === "ssh" && manual === null && h(Button, {
							size: "sm", variant: "ghost", disabled: manualBusy,
							onClick: loadManual,
						}, manualBusy ? "准备中…" : "改用手动步骤"))),

				manual !== null && h("div", { style: { marginTop: 8, paddingTop: 8, borderTop: `0.5px solid ${LINE}` } },
					h(Step, { index: 1, title: "在本机终端运行这条命令，建立安全通道（保持运行）" },
						h(CopyBlock, { hint: `建立后 ${manual.endpoint} 就是这台远程 dsh`, text: manual.tunnelCommand, mono: true })),
					h(Step, { index: 2, title: `打开 ${manual.endpoint} 进入远端 dsh，把下面这句话发给它的会话` },
						h(CopyBlock, { hint: "远端会回复一个访问令牌", text: manual.remoteParagraph })),
					h(Step, { index: 3, title: "把远端回复的令牌粘贴到这里" },
						h("textarea", {
							value: paste,
							onChange: (event) => setPaste(event.target.value),
							placeholder: "粘贴远端回复的令牌（或整个带 token 的地址）",
							style: {
								marginTop: 6, width: "100%", minHeight: 64, padding: "8px 10px",
								fontSize: 11, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
								color: INK, background: "transparent",
								border: `0.5px solid ${LINE}`, borderRadius: 10, resize: "vertical",
							},
						}),
						h("div", { style: { marginTop: 8 } },
							h(Button, {
								size: "sm",
								variant: "primary",
								disabled: manualBusy || paste.trim() === "",
								onClick: finishManual,
							}, manualBusy ? "验证中…" : "完成连接")))));
		}

		// ---------- remote-session marker ----------

		/**
		 * Shared, cheap store of "which local Sessions currently answer from a
		 * remote environment". Session rows are numerous, so one poller feeds all
		 * of them instead of each row asking the Host.
		 */
		const REMOTE = {
			ids: new Set(),
			environments: new Map(),
			listeners: new Set(),
			timer: undefined,
			started: false,
		};

		function publishRemote(items) {
			REMOTE.ids = new Set(items.map((item) => item.sessionId));
			REMOTE.environments = new Map(items.map((item) => [item.sessionId, item.environment]));
			for (const listener of REMOTE.listeners) {
				try {
					listener(REMOTE.ids.get(listener.sessionId) === undefined ? false : true);
				} catch { /* a broken row must not stop the others */ }
			}
		}

		async function refreshRemote(api) {
			const result = await api("remoteSessions", {});
			if (result.ok === true) publishRemote(result.value.items ?? []);
		}

		function startRemotePolling(api) {
			if (REMOTE.started) return;
			REMOTE.started = true;
			refreshRemote(api).catch(() => undefined);
			REMOTE.timer = setInterval(() => { refreshRemote(api).catch(() => undefined); }, 15_000);
			// Node-side callers (contract tests) must not be kept alive by the poller.
			REMOTE.timer?.unref?.();
		}

		/** Subscribe one row to the shared set. */
		function useRemoteSession(sessionId) {
			const [isRemote, setIsRemote] = useState(() => REMOTE.ids.has(sessionId));
			useEffect(() => {
				const listener = (value) => setIsRemote(value === true || REMOTE.ids.has(sessionId));
				listener.sessionId = sessionId;
				REMOTE.listeners.add(listener);
				setIsRemote(REMOTE.ids.has(sessionId));
				return () => { REMOTE.listeners.delete(listener); };
			}, [sessionId]);
			return isRemote;
		}

		/** Leading seat: a small globe while the row is idle (running rows show status dots). */
		function RemoteLeadingMark({ sessionId }) {
			const isRemote = useRemoteSession(sessionId);
			if (!isRemote) return null;
			const environment = REMOTE.environments.get(sessionId);
			return h("span", {
				title: environment === undefined ? "远程会话" : `远程会话 · ${environment}`,
				style: { display: "inline-flex", alignItems: "center", color: INK_SUB },
			}, h(IconGlobeOutlineRegular, { size: 12 }));
		}

		/** Trailing seat: an always-visible chip, since running rows take the leading seat. */
		function RemoteRowChip({ sessionId }) {
			const isRemote = useRemoteSession(sessionId);
			if (!isRemote) return null;
			const environment = REMOTE.environments.get(sessionId);
			return h(Tag, { tone: "outline" }, environment === undefined ? "远程" : `远程 · ${environment}`);
		}

		// ---------- panel ----------

		function Panel({ api }) {
			const [environments, setEnvironments] = useState(null);
			const [openName, setOpenName] = useState(null);
			const [sessions, setSessions] = useState({});
			const [adding, setAdding] = useState(false);
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState(null);

			const load = useCallback(async () => {
				setBusy(true);
				const result = await api("refresh", {});
				setBusy(false);
				if (result.ok === true) setEnvironments(result.value.items);
				else setNotice({ tone: "error", text: result.error.message });
			}, []);

			useEffect(() => { load(); }, []);

			const toggle = useCallback(async (name) => {
				const next = openName === name ? null : name;
				setOpenName(next);
				if (next !== null && sessions[name] === undefined) {
					const result = await api("sessions", { environment: name });
					setSessions((prev) => ({ ...prev, [name]: result }));
				}
			}, [openName, sessions]);

			const openInterface = useCallback(async (name) => {
				const result = await api("openWebUrl", { environment: name });
				if (result.ok === true && result.value.url) window.open(result.value.url, "_blank");
			}, []);

			const reconnect = useCallback(async (name) => {
				setBusy(true);
				const result = await api("reconnect", { environment: name });
				setBusy(false);
				if (result.ok === true) setEnvironments(result.value.items);
				else setNotice({ tone: "error", text: result.error.message });
			}, []);

			const remove = useCallback(async (name) => {
				const result = await api("removeEnvironment", { name });
				if (result.ok === false || result.value?.error !== undefined) {
					setNotice({ tone: "error", text: result.error?.message ?? result.value.error });
					return;
				}
				setSessions((prev) => { const next = { ...prev }; delete next[name]; return next; });
				load();
			}, []);

			const header = h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8 } },
				h("span", { style: { flex: 1, fontSize: 13, fontWeight: 600, color: INK } }, "远程 dsh 环境"),
				h(Button, {
					size: "sm", variant: "ghost", disabled: busy,
					icon: h(IconRefreshOutlineRegular, { size: 14 }),
					onClick: load, title: "刷新状态",
				}),
				h(Button, {
					size: "sm", variant: "primary",
					icon: h(IconPlusOutlineRegular, { size: 14 }),
					onClick: () => { setNotice(null); setAdding(true); },
				}, "添加环境"));

			const body = [];
			if (adding) {
				body.push(h(AddEnvironment, {
					key: "add",
					api,
					onClose: () => setAdding(false),
					onDone: (message) => {
						setAdding(false);
						setNotice({ tone: "success", text: message });
						load();
					},
				}));
			}

			if (environments === null) {
				body.push(h("div", { key: "loading", style: { fontSize: 12, color: INK_SUB, padding: "10px 0" } }, "正在读取环境…"));
			} else if (environments.length === 0 && !adding) {
				body.push(h("div", { key: "empty", style: { padding: "18px 4px", textAlign: "center" } },
					h("div", { style: { fontSize: 12, color: INK_SUB, lineHeight: 1.9 } },
						"还没有连接远程环境。",
						h("br"),
						"填一个服务器地址就能连上，之后可以在这里查看它的会话。"),
					h("div", { style: { marginTop: 10 } },
						h(Button, {
							size: "sm", variant: "primary",
							icon: h(IconPlusOutlineRegular, { size: 14 }),
							onClick: () => setAdding(true),
						}, "添加环境"))));
			} else {
				body.push(h("div", { key: "list" }, environments.map((environment) => {
					const status = statusOf(environment);
					const summary = environmentSummary(environment);
					const reconnecting = environment.channel?.kind === "ssh" && environment.channel.restarts > 0;
					return h(DisclosureRow, {
						key: environment.name,
						icon: h(StateDot, { state: status.dot, size: 10 }),
						title: environment.name,
						// The row renders name and this span adjacently, so the summary carries its
						// own separator: "cn-dsh2" + " · 已连接 · …", never "cn-dsh2已连接".
						collapsedContent: h("span", { style: { fontSize: 11, color: INK_SUB } }, ` · ${summary}`),
						open: openName === environment.name,
						expandable: true,
						expandOnRowClick: true,
						onToggle: () => toggle(environment.name),
					},
						h("div", { style: { padding: "2px 0 8px" } },
							h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 6 } },
								needsReconnect(environment) && h(Button, {
									size: "sm", variant: "primary", disabled: busy,
									icon: h(IconRefreshOutlineRegular, { size: 13 }),
									onClick: () => reconnect(environment.name),
								}, "重连"),
								h(Button, {
									size: "sm", variant: "outline",
									icon: h(IconRightUpOutlineRegular, { size: 13 }),
									onClick: () => openInterface(environment.name),
								}, "打开界面"),
								h(Button, {
									size: "sm", variant: "ghost",
									icon: h(IconTrashOutlineRegular, { size: 13 }),
									disabled: environment.source !== "panel",
									title: environment.source === "panel" ? "移除这个环境" : "在配置文件中声明的环境",
									onClick: () => remove(environment.name),
								}, "移除")),
							environment.ready === false && h(Notice, { tone: "error" }, "接入信息缺失，请重新添加这个环境"),
							environment.status === "connected" && environment.workspace == null &&
								h(Notice, { tone: "error" }, "这个环境还没有工作区，点上面的「重连」补建（会在本机建一个同名目录）"),
							reconnecting && h(Notice, null, `通道重连过 ${environment.channel.restarts} 次（插件会自动保持连接）`),
							environment.detail != null && h(Notice, null, environment.detail),
							h(SessionList, { state: sessions[environment.name] })));
				})));
			}

			if (notice !== null) body.push(h(Notice, { key: "notice", tone: notice.tone }, notice.text));

			return h("div", { style: { padding: 12, fontSize: 12, height: "100%", overflow: "auto", color: INK } }, header, body);
		}

		function Title() {
			return h("span", null, "远程 dsh 环境");
		}

		// ---------- remote environment page (scenario 2) ----------

		/**
		 * Full-width native view of the remote environments: environment tabs on
		 * top, remote session list on the left, the selected conversation on the
		 * right. Everything flows through our SSH tunnel and the remote dsh APIs —
		 * no browser embedding, no cookies of its own to worry about.
		 */
		function RemoteEnvPage({ api }) {
			const [envs, setEnvs] = useState([]);
			const [loading, setLoading] = useState(true);
			const [envError, setEnvError] = useState(null);
			const [activeEnv, setActiveEnv] = useState(null);
			const [sessions, setSessions] = useState(undefined);
			const [activeSessionId, setActiveSessionId] = useState(null);
			const [reconnecting, setReconnecting] = useState(false);

			const loadEnvs = useCallback(async () => {
				const result = await api("environments", {});
				if (result.ok === true) { setEnvs(result.value.items ?? []); setEnvError(null); }
				else setEnvError(result.error?.message ?? "读取环境失败");
				setLoading(false);
			}, []);

			const loadSessions = useCallback(async (env) => {
				const result = await api("sessions", { environment: env });
				setSessions(result.ok === true ? result.value : { error: result.error?.message ?? "读取会话失败" });
			}, []);

			useEffect(() => { loadEnvs(); }, [loadEnvs]);

			const enterEnv = useCallback((name) => {
				setActiveEnv(name);
				setActiveSessionId(null);
				setSessions(undefined);
				loadSessions(name);
			}, [loadSessions]);

			// Keep the session list fresh while the page is open.
			useEffect(() => {
				if (activeEnv === null) return;
				const timer = setInterval(() => { loadSessions(activeEnv); }, 15000);
				return () => clearInterval(timer);
			}, [activeEnv, loadSessions]);

			const reconnect = useCallback(async () => {
				if (activeEnv === null) return;
				setReconnecting(true);
				const result = await api("reconnect", { environment: activeEnv });
				setReconnecting(false);
				if (result.ok === false) { setSessions({ error: result.error?.message ?? "重连失败" }); return; }
				await loadEnvs();
				await loadSessions(activeEnv);
			}, [activeEnv, loadEnvs, loadSessions]);

			const active = envs.find((e) => e.name === activeEnv);
			const items = Array.isArray(sessions?.items) ? sessions.items : [];
			const activeSession = items.find((row) => row.sessionId === activeSessionId) ?? null;

			return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } },
				// top bar: environment tabs
				h("div", {
					style: {
						display: "flex", alignItems: "center", gap: 6, padding: "8px 12px",
						borderBottom: `0.5px solid ${LINE}`, flex: "none", flexWrap: "wrap",
					},
				},
					h("span", { style: { fontSize: 13, fontWeight: 600, color: INK, marginRight: 8 } }, "远程环境"),
					envs.map((env) =>
						h("button", {
							key: env.name,
							style: {
								display: "inline-flex", alignItems: "center", gap: 5,
								padding: "4px 12px", borderRadius: 6, fontSize: 12, cursor: "pointer",
								border: `0.5px solid ${activeEnv === env.name ? "rgba(31,111,235,0.9)" : LINE}`,
								background: activeEnv === env.name ? "rgba(31,111,235,0.10)" : "transparent",
								color: activeEnv === env.name ? INK : INK_SUB,
							},
							onClick: () => enterEnv(env.name),
						},
							h(StateDot, { state: statusOf(env).dot, size: 7 }),
							env.name)),
					loading && h("span", { style: { fontSize: 12, color: INK_SUB } }, "加载中…"),
					!loading && envs.length === 0 && h("span", { style: { fontSize: 12, color: INK_SUB } },
						"还没有远程环境：打开右侧「远程 dsh 环境」面板添加"),
					envError !== null && h("span", { style: { fontSize: 12, color: DANGER } }, envError)),

				// body: session list + conversation
				h("div", { style: { flex: 1, minHeight: 0, display: "flex" } },
					activeEnv === null
						? h("div", { style: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: INK_SUB, fontSize: 13 } },
							envs.length === 0 ? "添加远程环境后，这里会列出它们" : "点击上方环境名查看它的会话")
						: h("div", { style: { width: 260, flex: "none", borderRight: `0.5px solid ${LINE}`, display: "flex", flexDirection: "column", minHeight: 0 } },
							h("div", { style: { padding: "8px 12px", fontSize: 11, color: INK_SUB, flex: "none" } }, "远端会话"),
							sessions === undefined
								? h("div", { style: { padding: "6px 12px", fontSize: 12, color: INK_SUB } }, "正在读取…")
							: sessions.error !== undefined
								? h("div", { style: { padding: "6px 12px", display: "grid", gap: 8 } },
									h("div", { style: { fontSize: 12, color: DANGER } }, sessions.error),
									active !== undefined && active.status !== "connected" && h(Button, {
										size: "sm", variant: "outline", disabled: reconnecting, onClick: reconnect,
									}, reconnecting ? "重连中…" : "重连"))
								: items.length === 0
									? h("div", { style: { padding: "6px 12px", fontSize: 12, color: INK_SUB } }, "这个环境里还没有会话")
									: h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", padding: "0 6px" } },
										items.map((session) =>
											h("div", {
												key: session.sessionId,
												style: {
													display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 8,
													cursor: "pointer", marginBottom: 2,
													background: activeSessionId === session.sessionId ? "rgba(31,111,235,0.10)" : "transparent",
												},
												onClick: () => setActiveSessionId(session.sessionId),
											},
												h(StateDot, { state: session.running ? "ongoing" : "idle", size: 7 }),
												h("span", {
													style: { flex: 1, minWidth: 0, fontSize: 12, color: INK, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
													title: session.title ?? session.sessionId,
												}, session.title ?? session.sessionId.slice(0, 24)),
												h("span", { style: { fontSize: 10, color: INK_SUB, flex: "none" } }, fmtTime(session.updatedAt)))))),
						activeSessionId !== null && activeSession !== null
							? h(RemoteConversation, {
								api, environment: activeEnv, session: activeSession,
								onChanged: () => { loadSessions(activeEnv); loadEnvs(); },
							})
							: h("div", { style: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: INK_SUB, fontSize: 13 } },
								activeEnv === null ? "" : "选择左侧会话查看对话")));
		}

		// ---------- apply ----------

		const inject = ["slots", "connection", "sidebarRightTabs"];

		function apply(ctx) {
			const api = makeApi(ctx);
			// Tab type only. The guide capsule itself is rendered by the sidebar's
			// EntryBox, which owns the click that opens this tab — registering a
			// component into "sidebar.right.tab.guide.entry" would replace that
			// clickable capsule and make the entry impossible to open.
			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: TAB_ID,
				kind: TAB_ID,
				multiple: false,
				title: () => "远程 dsh 环境",
				guide: [{
					id: "panel",
					order: 90,
					title: () => "远程 dsh 环境",
					description: () => "连接其他机器上的 dsh，查看它们的会话",
					icon: primitives.PluginArtworkSubagent,
				}],
			}));
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () =>
				ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID }, function Body() {
					return h(Panel, { api });
				})));
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () =>
				ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: TAB_ID }, Title)));
			// Session-row markers: the leading seat shows a globe while the row is
			// idle; the trailing chip stays visible in every state (a running row
			// replaces the leading seat with its status dots).
			startRemotePolling(api);
			ctx.effect(() => ctx.slots.inject("sidebar.session.row.leading", () =>
				ctx.slots.register({ name: "sidebar.session.row.leading", id: `${TAB_ID}-mark`, order: 100 }, RemoteLeadingMark)));
			ctx.effect(() => ctx.slots.inject("sidebar.workspaces.session.row.action", () =>
				ctx.slots.register({ name: "sidebar.workspaces.session.row.action", id: `${TAB_ID}-chip`, order: 100 }, RemoteRowChip)));

			// Scenario 2: a top-level "远程环境" button in the left sidebar,
			// opening a full-width page that renders remote sessions natively.
			// Same pattern as dsh's built-in "plugins" panel.
			const REMOTE_ENV_PANEL = "dsh-control-remote-env";
			ctx.effect(() => ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register({
					name: "sidebar.panellist",
					id: REMOTE_ENV_PANEL,
					order: 15,
					label: () => "远程环境",
				}, function RemoteEnvIcon({ size, active }) {
					return h("span", {
						style: { display: "inline-flex", alignItems: "center", justifyContent: "center",
							color: active ? INK : INK_SUB },
					}, h(IconGlobeOutlineRegular, { size: size ?? 18 }));
				})));
			ctx.effect(() => ctx.slots.inject("main", () =>
				ctx.slots.register({ name: "main", key: REMOTE_ENV_PANEL }, function Page() {
					return h(RemoteEnvPage, { api });
				})));
		}

		exports.apply = apply;
		exports.inject = inject;
		// Interaction decisions exposed for unit tests: the panel's behaviour
		// (which failure shows which actions, when 重连 appears) must be verifiable
		// without a browser. The loader only reads apply/inject.
		exports.__internals = {
			noticeFromConnectResult,
			statusOf,
			needsReconnect,
			environmentSummary,
			STATUS,
		};
		return module.exports;
	},
});

//# sourceMappingURL=client.js.map
