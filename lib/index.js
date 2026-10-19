/**
 * dsh-control host entry.
 *
 * Registers the `dshControl` Typert Remote service: remote dsh environments in
 * the local interface. Methods run in SRC mode (simple named parameters,
 * JSON-safe values) — no generated descriptors, so the plugin stays build-free.
 *
 * Connection design (see README):
 *   - SSH mode (default): the user supplies only `user@host`. The plugin probes
 *     the remote machine over SSH, reads the dsh launch token out of the
 *     service log, allocates and remembers a local port, then keeps an SSH
 *     tunnel open (lazily started, auto-reconnecting). The remote dsh itself is
 *     long-lived and owned by the remote machine.
 *   - Direct mode (planned): a remote dsh already reachable at a URL.
 *   - Manual steps stay available as a fallback when automation cannot run.
 *
 * Environment sources (merged):
 *   - config environments (cordis.patch.yml)
 *   - state-file environments ($DSH_HOME/dsh-control/state.json, mode 600)
 */
import { mkdir, readFile, writeFile, chmod, stat, access } from "node:fs/promises";
import { createServer } from "node:net";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { RemoteDsh } from "./connections.js";
import { buildTunnelCommand, buildRemoteParagraph, parseConnectBlock, suggestName } from "./onboarding.js";
import { TunnelManager } from "./tunnel.js";
import { mountEnvironmentProxy } from "./proxy.js";
import { runSsh, buildProbeScript, parseRemoteReport, sshFailureHint, isAuthFailure, defaultPublicKeyPath, buildAuthFix } from "./ssh.js";
import { applyWorkspaceResult, nextWorkspacePath, pollUntil, workspaceBaseDirectory } from "./workspace.js";
import { RemoteEnvironmentAdapter, PROVIDER } from "./adapter.js";

/** Apply the Remote marker to a class method without decorator syntax. */
function markRemote(klass, methodName, exportName = methodName) {
	Remote(exportName)(undefined, {
		name: methodName,
		private: false,
		static: false,
		addInitializer(fn) {
			fn.call(Object.create(klass.prototype));
		},
	});
}

const DEFAULT_REMOTE_PORT = 3080;

class DshControlService extends TypertRemoteService {
	constructor(ctx, config) {
		super(ctx, "dshControl");
		this.config = config ?? {};
		this.runtimeEnvironments = new Map(); // name -> spec (from state file)
		this.clients = new Map(); // name -> RemoteDsh
		this.sessionBindings = new Map(); // localSessionId -> { environment, remoteSessionId }
		this.tunnels = new TunnelManager();
		this.proxyMounts = new Map(); // environment -> {prefix, dispose}
		if (typeof ctx.effect === "function") ctx.effect(() => () => this.dispose());
		this.ready = this.loadState();
		this.registerAdapter(ctx);
		this.bindSessionCreation(ctx);
		// A restart alone must be enough to repair environments that never got
		// their Workspace; failures are recorded in state.json.
		this.ready.then(() => this.healWorkspaces()).catch(() => undefined);
	}

	/**
	 * A Session created inside an environment's Workspace becomes a remote
	 * Session: its model route is pointed at that environment before it runs
	 * anything, so the person just types and the remote does the work.
	 */
	bindSessionCreation(ctx) {
		if (typeof ctx.on !== "function") return;
		ctx.on("session/created", (session) => {
			this.onSessionCreated(session).catch(() => undefined);
		});
	}

	async onSessionCreated(session) {
		await this.ready;
		const sessionId = typeof session?.id === "string" ? session.id : undefined;
		const cwd = session?.header?.cwd;
		if (sessionId === undefined || typeof cwd !== "string" || cwd === "") return;
		const environment = this.environmentForPath(cwd);
		if (environment === undefined) return;
		if (this.sessionBindings.has(sessionId)) return;
		await this.selectRemoteRoute(sessionId, environment);
		// Pair the remote Session right away so the first message has somewhere to go.
		await this.resolveRemoteSession(sessionId, environment).catch(() => undefined);
	}

	/** Environment whose Workspace directory contains (or equals) this path. */
	environmentForPath(cwd) {
		for (const [name, spec] of this.allSpecs()) {
			const workspacePath = spec.workspacePath;
			if (typeof workspacePath !== "string" || workspacePath === "") continue;
			if (cwd === workspacePath || cwd.startsWith(`${workspacePath}/`)) return name;
		}
		return undefined;
	}

	/** Point one Session's model route at an environment. */
	async selectRemoteRoute(sessionId, environment) {
		const controller = typeof this.ctx.get === "function" ? this.ctx.get("sessionController") : this.ctx.sessionController;
		if (controller === undefined || typeof controller.selectModel !== "function") {
			this.routeError = "当前 profile 没有 sessionController，无法自动绑定路由";
			return false;
		}
		try {
			await controller.selectModel({ sessionId, provider: PROVIDER, model: environment });
			this.routeError = undefined;
			return true;
		} catch (error) {
			this.routeError = error instanceof Error ? error.message : String(error);
			return false;
		}
	}

	/** The local Session's title, when the profile can report projections. */
	async localTitle(sessionId) {
		const controller = typeof this.ctx.get === "function" ? this.ctx.get("sessionController") : this.ctx.sessionController;
		if (controller === undefined || typeof controller.projections !== "function") return undefined;
		try {
			const value = await controller.projections({ sessionId }, AbortSignal.timeout(3_000));
			const values = value?.values;
			const title = values instanceof Map ? values.get("title") : values?.title;
			return typeof title === "string" && title.trim() !== "" ? title.trim() : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Keep the remote Session named `控制端·<local title>`, so the remote side can
	 * always tell which local conversation it belongs to. A title only exists
	 * after the first reply, so this is re-applied after every turn.
	 */
	async applyRemoteTitle(localSessionId, environment, remoteSessionId) {
		const title = await this.localTitle(localSessionId);
		const desired = `控制端·${title ?? environment}`;
		const binding = this.sessionBindings.get(localSessionId);
		if (binding?.remoteTitle === desired) return;
		const connection = this.clientFor(environment);
		if (connection === undefined) return;
		const renamed = await connection.call("session/rename", { request: { sessionId: remoteSessionId, title: desired } });
		if (renamed.ok === false) return;
		this.sessionBindings.set(localSessionId, {
			...(binding ?? {}),
			environment,
			remoteSessionId,
			remoteTitle: desired,
		});
		await this.saveState();
	}

	/** Re-apply the remote title for a bound session (called after each turn). */
	async refreshRemoteTitle(localSessionId, environment) {
		const binding = this.sessionBindings.get(String(localSessionId ?? ""));
		if (binding === undefined) return;
		await this.applyRemoteTitle(binding.localSessionId ?? localSessionId, environment ?? binding.environment, binding.remoteSessionId);
	}

	/** Sessions currently answering from a remote environment (for the UI marker). */
	async remoteSessions() {
		await this.ready;
		const items = [];
		for (const [sessionId, binding] of this.sessionBindings) {
			items.push({
				sessionId,
				environment: binding.environment,
				remoteSessionId: binding.remoteSessionId,
				remoteTitle: binding.remoteTitle ?? null,
			});
		}
		return { items };
	}

	/**
	 * Publish the remote-environment model route, so a local Session can select
	 * `dsh-control/<environment>` and have its model calls answered by that
	 * environment instead of a local provider.
	 */
	registerAdapter(ctx) {
		// Services activate asynchronously: at construction time `llm` may not
		// exist yet, so registration waits for it through `ctx.inject` rather
		// than reading the service eagerly (the official pattern).
		if (typeof ctx.inject === "function") {
			ctx.inject(["llm"], (llmCtx) => {
				this.attachAdapter(llmCtx.llm ?? llmCtx.get?.("llm"));
			});
			return;
		}
		this.attachAdapter(typeof ctx.get === "function" ? ctx.get("llm") : ctx.llm);
	}

	attachAdapter(llm) {
		this.llm = llm;
		if (llm === undefined) {
			this.adapterStatus = { registered: false, reason: "当前 profile 没有 llm 服务" };
			return;
		}
		if (typeof llm.registerAdapter !== "function") {
			this.adapterStatus = { registered: false, reason: "llm.registerAdapter 不可用" };
			return;
		}
		try {
			this.adapterDispose = llm.registerAdapter([PROVIDER], new RemoteEnvironmentAdapter({
				listEnvironments: async () => {
					await this.ready;
					return [...this.allSpecs().keys()];
				},
				connectionFor: (environment) => this.clientFor(environment),
				resolveRemoteSession: (localSessionId, environment) => this.resolveRemoteSession(localSessionId, environment),
				afterTurn: (localSessionId, environment) => this.refreshRemoteTitle(localSessionId, environment),
				onRequest: (snapshot) => { this.lastRequest = snapshot; },
				onStream: (report) => { this.lastStream = report; },
			}));
			this.adapterStatus = { registered: true, provider: PROVIDER };
		} catch (error) {
			// Never silent: a route this plugin cannot own is a fact the panel and
			// diagnostics must be able to report.
			this.adapterStatus = { registered: false, reason: error instanceof Error ? error.message : String(error) };
		}
	}

	/** Self-report used by the panel and by development checks. */
	async diagnostics() {
		await this.ready;
		let providers;
		try {
			providers = this.llm?.listProviders?.().map((provider) => provider.id) ?? null;
		} catch (error) {
			providers = `读取失败：${error instanceof Error ? error.message : String(error)}`;
		}
		return {
			adapter: this.adapterStatus ?? { registered: false, reason: "未尝试注册" },
			providers,
			lastRequest: this.lastRequest ?? null,
			lastStream: this.lastStream ?? null,
			environments: [...this.allSpecs().keys()],
			bindings: this.sessionBindings.size,
			channels: [...this.allSpecs().keys()].map((name) => ({ name, ...this.tunnels.status(name) })),
		};
	}

	/**
	 * Local Session -> remote Session pairing. Created on first use and kept in
	 * state.json, so a restarted dsh keeps talking to the same remote session.
	 */
	async resolveRemoteSession(localSessionId, environment) {
		await this.ready;
		const key = String(localSessionId ?? "");
		const binding = this.sessionBindings.get(key);
		if (binding !== undefined && binding.environment === environment) return binding.remoteSessionId;

		const connection = this.clientFor(environment);
		if (connection === undefined) throw new Error(`dsh-control: unknown environment ${JSON.stringify(environment)}`);
		const spec = this.allSpecs().get(environment) ?? { name: environment };
		const channel = await this.ensureTunnel(spec);
		if (channel?.ok === false) {
			throw new Error(`dsh-control: 通道未就绪：${channel.error ?? "未知原因"}`);
		}

		// No working directory is imposed: the remote dsh picks its own default.
		// Creating directories on someone else's machine would depend on their
		// service manager, user layout and paths — exactly what this plugin avoids.
		let created = await connection.call("session/create", { request: {} });
		// A channel can die between "ensured" and "used" (an earlier tunnel was
		// adopted just as it went away). Rebuild once instead of failing the turn.
		if (created.ok === false && /拒绝|不可达|refused|unreachable/i.test(created.error?.message ?? "")) {
			this.tunnels.stop(environment);
			const rebuilt = await this.ensureTunnel(spec);
			if (rebuilt?.ok === false) {
				throw new Error(`dsh-control: 通道重建失败：${rebuilt.error ?? "未知原因"}`);
			}
			created = await connection.call("session/create", { request: {} });
		}
		if (created.ok === false) {
			throw new Error(`dsh-control: 无法在远端新建会话：${created.error?.message ?? "未知错误"}`);
		}
		const remoteSessionId = created.value?.sessionId;
		if (typeof remoteSessionId !== "string" || remoteSessionId === "") {
			throw new Error("dsh-control: 远端没有返回会话标识");
		}
		this.sessionBindings.set(key, { environment, remoteSessionId });
		await this.saveState();
		await this.applyRemoteTitle(key, environment, remoteSessionId).catch(() => undefined);
		return remoteSessionId;
	}

	dispose() {
		for (const { dispose } of this.proxyMounts.values()) { try { dispose(); } catch { /* gone */ } }
		this.proxyMounts.clear();
		this.tunnels.disposeAll();
		this.clients.clear();
		if (typeof this.adapterDispose === "function") {
			try {
				this.adapterDispose();
			} catch { /* already withdrawn */ }
			this.adapterDispose = undefined;
		}
	}

	// ---------- environment registry ----------

	stateFilePath() {
		return join(dshHome(), "dsh-control", "state.json");
	}

	async loadState() {
		try {
			const raw = JSON.parse(await readFile(this.stateFilePath(), "utf8"));
			const stored = raw.environments ?? raw.hosts ?? {};
			for (const spec of Object.values(stored)) {
				if (spec?.name) this.runtimeEnvironments.set(spec.name, spec);
			}
			for (const [localSessionId, binding] of Object.entries(raw.sessionBindings ?? {})) {
				if (typeof binding?.remoteSessionId === "string") this.sessionBindings.set(localSessionId, binding);
			}
		} catch {
			/* first run or unreadable — start empty */
		}
	}

	async saveState() {
		const file = this.stateFilePath();
		await mkdir(dirname(file), { recursive: true });
		const environments = {};
		for (const spec of this.runtimeEnvironments.values()) environments[spec.name] = spec;
		const sessionBindings = {};
		for (const [localSessionId, binding] of this.sessionBindings) sessionBindings[localSessionId] = binding;
		await writeFile(file, JSON.stringify({ environments, sessionBindings }, null, "\t") + "\n", { mode: 0o600 });
		try {
			const info = await stat(file);
			if ((info.mode & 0o777) !== 0o600) await chmod(file, 0o600);
		} catch { /* best effort */ }
	}

	configEnvironments() {
		const list = this.config.environments ?? this.config.hosts;
		return Array.isArray(list) ? list : [];
	}

	allSpecs() {
		const merged = new Map();
		for (const spec of this.configEnvironments()) {
			if (spec?.name) merged.set(spec.name, { ...spec, source: "config" });
		}
		for (const spec of this.runtimeEnvironments.values()) {
			merged.set(spec.name, { ...spec, source: "panel" });
		}
		return merged;
	}

	clientFor(name) {
		const spec = this.allSpecs().get(name);
		if (spec === undefined) return undefined;
		let client = this.clients.get(name);
		if (client === undefined || client.token !== spec.token || client.endpoint !== spec.endpoint) {
			client = new RemoteDsh(spec);
			this.clients.set(name, client);
		}
		return client;
	}

	/** Make sure the channel to one environment is up (SSH environments only). */
	async ensureTunnel(spec) {
		if (typeof spec.sshTarget !== "string" || spec.sshTarget === "") return { ok: true };
		const localPort = spec.localPort ?? await pickFreePort();
		return await this.tunnels.ensure({
			name: spec.name,
			target: spec.sshTarget,
			localPort,
			remotePort: spec.remotePort ?? DEFAULT_REMOTE_PORT,
		});
	}

	// ---------- local workspace per environment ----------

	workspaceController() {
		return typeof this.ctx.get === "function" ? this.ctx.get("workspaceController") : this.ctx.workspaceController;
	}

	/**
	 * Give an environment a local Workspace beside the default one, named after
	 * the environment. Idempotent: an environment that already has a workspace
	 * resolves to it. Never throws — a missing workspace feature must not sink a
	 * successful connection.
	 */
	async ensureWorkspace(spec) {
		// Services activate asynchronously: right after startup the Workspace
		// controller may not exist yet, so wait for it instead of giving up.
		const controller = await this.waitForWorkspaceController();
		if (controller === undefined) {
			const reason = this.workspaceController() === undefined
				? "当前 profile 没有工作区能力"
				: "工作区服务一直没就绪";
			return { ok: false, error: reason };
		}
		try {
			if (typeof spec.workspaceId === "string" && spec.workspaceId !== "") {
				return { ok: true, workspaceId: spec.workspaceId, path: spec.workspacePath };
			}
			const base = workspaceBaseDirectory(dshHome());
			const path = await nextWorkspacePath(base, spec.name, pathExists);
			await mkdir(path, { recursive: true });
			const result = await controller.create({ path });
			return {
				ok: true,
				workspaceId: result.workspace.workspaceId,
				path: result.workspace.path,
				created: result.created === true,
			};
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/**
	 * Ensure the environment's home Workspace exists and remember it.
	 * Every path that ends with a usable environment goes through here, so a
	 * connected environment can never end up without its Workspace in the sidebar.
	 */
	/** Wait (briefly) for the async Workspace service to activate. */
	waitForWorkspaceController(timeoutMs = 10_000) {
		return pollUntil(() => this.workspaceController(), { timeoutMs, intervalMs: 200 });
	}

	async ensureWorkspaceAndKeep(spec) {
		const workspace = await this.ensureWorkspace(spec);
		this.runtimeEnvironments.set(spec.name, applyWorkspaceResult(spec, workspace));
		await this.saveState().catch(() => undefined);
		return workspace ?? { ok: false, error: "工作区创建失败" };
	}

	/**
	 * Every known environment must have its Workspace, including ones added
	 * before this existed. Runs once at startup so a restart is enough to repair
	 * an environment — and records the reason in state.json when it cannot.
	 */
	async healWorkspaces() {
		await this.ready;
		for (const spec of [...this.allSpecs().values()]) {
			if (typeof spec.workspaceId === "string" && spec.workspaceId !== "") continue;
			if (this.runtimeEnvironments.has(spec.name) === false && spec.source === "config") continue;
			await this.ensureWorkspaceAndKeep(spec).catch(async (error) => {
				this.runtimeEnvironments.set(spec.name, applyWorkspaceResult(spec, { ok: false, error: errorText(error) }));
				await this.saveState().catch(() => undefined);
			});
		}
	}

	/** Drop the Workspace registration an environment created (directory stays). */
	async dropWorkspace(spec) {
		const controller = this.workspaceController();
		if (controller === undefined) return;
		if (typeof spec.workspaceId !== "string" || spec.workspaceId === "") return;
		try {
			await controller.delete({ workspaceId: spec.workspaceId });
		} catch { /* a workspace the user already removed is fine */ }
	}

	// ---------- remote methods (SRC: named args) ----------

	/** List configured environments with status. */
	async environments() {
		await this.ready;
		const items = [];
		for (const [name, spec] of this.allSpecs()) {
			const client = this.clientFor(name);
			const tunnel = this.tunnels.status(name);
			const isSsh = typeof spec.sshTarget === "string" && spec.sshTarget !== "";
			// Warm the channel in the background while the user is still looking at
			// the list: by the time they pick an environment the tunnel is up, and
			// after a sleep/boot this is what removes the "waiting for reconnect".
			if (isSsh && tunnel.running !== true) {
				this.ensureTunnel(spec).catch(() => {});
			}
			items.push({
				name,
				endpoint: spec.endpoint ?? null,
				sshTarget: spec.sshTarget ?? null,
				remotePort: spec.remotePort ?? null,
				source: spec.source,
				ready: typeof spec.token === "string" && spec.token !== "",
				status: client.lastStatus,
				detail: client.lastDetail ?? null,
				lastCheckedAt: client.lastCheckedAt ?? null,
				workspace: typeof spec.workspacePath === "string" ? { path: spec.workspacePath } : null,
				workspaceError: typeof spec.workspaceError === "string" ? spec.workspaceError : null,
				channel: isSsh
					? { kind: "ssh", running: tunnel.running, restarts: tunnel.restarts ?? 0, lastError: tunnel.lastError ?? null }
					: { kind: "direct" },
			});
		}
		return { items };
	}

	/**
	 * One-click connect for an SSH environment: probe, read the token, open the
	 * channel, verify. Primary path; `setupSteps` is the manual fallback.
	 */
	async connect(sshTarget, name) {
		await this.ready;
		if (typeof sshTarget !== "string" || sshTarget.trim() === "") {
			return { error: "请填写服务器地址（形如 user@1.2.3.4）" };
		}
		const target = sshTarget.trim();
		const resolvedName = typeof name === "string" && name.trim() !== "" ? name.trim() : suggestName(target);
		if (!/^[\w.-]+$/.test(resolvedName)) return { error: "名称只能包含字母、数字、点、下划线、连字符" };

		const probe = await runSsh(target, buildProbeScript());
		if (probe.stdout.trim() === "" && probe.code !== 0) {
			// Rejected credentials are the one failure the user can fix in a minute,
			// so hand them the exact command instead of a bare error.
			if (isAuthFailure(probe.stderr)) {
				return {
					error: "这台服务器还没有接受你本机的密钥",
					detail: "自动连接需要免密登录（密钥认证）。配置一次即可；也可以用下面的手动步骤，在终端里输密码。",
					fix: buildAuthFix(target, defaultPublicKeyPath()),
					manual: true,
					retry: true,
				};
			}
			return { error: sshFailureHint(probe.stderr), retry: true };
		}
		const report = parseRemoteReport(probe.stdout);
		if (report.process === undefined) {
			return {
				error: "这台机器上没有在运行的 dsh",
				manual: true,
				detail: "先在那台机器上把它跑起来，或改用手动步骤。",
			};
		}
		if (report.token === undefined) {
			return {
				error: "读取访问令牌失败",
				manual: true,
				detail: report.unit === undefined
					? "没有在日志里找到它的访问令牌。可以让那台机器重新启动一次 dsh，或改用手动步骤。"
					: `没有在 ${report.unit} 的日志里找到访问令牌。可以让那台机器重新启动一次 dsh，或改用手动步骤。`,
			};
		}

		const remotePort = report.process.port ?? DEFAULT_REMOTE_PORT;
		const remembered = this.allSpecs().get(resolvedName)?.localPort;
		const localPort = await reserveLocalPort(remembered);
		const channel = await this.tunnels.ensure({ name: resolvedName, target, localPort, remotePort });
		if (channel.ok === false) {
			return { error: `建立加密通道失败：${channel.error}` };
		}

		const spec = {
			name: resolvedName,
			endpoint: `http://127.0.0.1:${localPort}`,
			token: report.token,
			remotePort,
			localPort,
			sshTarget: target,
		};
		this.runtimeEnvironments.set(resolvedName, spec);
		this.clients.delete(resolvedName);
		const probeResult = await this.clientFor(resolvedName).sessions();
		if (probeResult.ok === false) {
			await this.saveState();
			return {
				error: `通道已建立，但访问这台 dsh 失败：${probeResult.error?.message ?? probeResult.error}`,
				detail: `如果本地端口 ${localPort} 已被别的程序占用，移除这个环境后重试。`,
				name: resolvedName,
			};
		}
		// Connected: give it a home in the sidebar, named after the environment.
		const workspace = await this.ensureWorkspaceAndKeep(spec);
		await this.saveState();
		return {
			name: resolvedName,
			sessions: probeResult.value.items.length,
			localPort,
			remotePort,
			unit: report.unit ?? null,
			workspace: workspace.ok === true ? { path: workspace.path, created: workspace.created === true } : undefined,
			workspaceError: workspace.ok === true ? undefined : workspace.error,
		};
	}

	/** Re-probe every environment (opening its channel first when needed). */
	async refresh() {
		await this.ready;
		await Promise.all([...this.allSpecs().entries()].map(async ([name, spec]) => {
			const client = this.clientFor(name);
			if (client === undefined) return;
			await this.ensureTunnel(spec).catch(() => undefined);
			await client.sessions().catch(() => undefined);
		}));
		return this.environments();
	}

	/**
	 * Re-read the launch token (and port) from the remote machine over SSH.
	 * The token is per-process: whenever the remote dsh restarts it changes, and
	 * the stored one silently stops working. Because an SSH environment already
	 * gives us a way in, recovery is our job — the user should never have to
	 * re-add an environment just because the remote was restarted.
	 */
	async refreshCredentials(spec) {
		if (typeof spec.sshTarget !== "string" || spec.sshTarget === "") {
			return { ok: false, error: "该环境不是通过 SSH 接入的，无法自动重读凭证" };
		}
		const probe = await runSsh(spec.sshTarget, buildProbeScript());
		if (probe.stdout.trim() === "" && probe.code !== 0) {
			return { ok: false, error: sshFailureHint(probe.stderr) };
		}
		const report = parseRemoteReport(probe.stdout);
		if (report.process === undefined) return { ok: false, error: "这台机器上没有在运行的 dsh" };
		if (report.token === undefined) return { ok: false, error: "读不到访问令牌" };

		const remotePort = report.process.port ?? spec.remotePort ?? DEFAULT_REMOTE_PORT;
		if (remotePort !== spec.remotePort) this.tunnels.stop(spec.name);
		const updated = {
			...spec,
			token: report.token,
			remotePort,
			endpoint: spec.localPort === undefined ? spec.endpoint : `http://127.0.0.1:${spec.localPort}`,
		};
		this.runtimeEnvironments.set(spec.name, updated);
		await this.saveState();
		this.clients.delete(spec.name);
		return { ok: true, tokenChanged: report.token !== spec.token };
	}

	/**
	 * Retry one environment (the「重连」action). For SSH environments this also
	 * re-reads the token, so a restarted remote heals by itself.
	 */
	async reconnect(environment) {
		await this.ready;
		const spec = this.allSpecs().get(environment);
		if (spec === undefined) throw new Error(`dsh-control: unknown environment ${JSON.stringify(environment)}`);
		if (typeof spec.sshTarget === "string" && spec.sshTarget !== "") {
			await this.refreshCredentials(spec).catch(() => undefined);
		}
		// Self-heal environments that were added before their Workspace existed
		// (the manual paste path used to skip it).
		if (typeof spec.workspaceId !== "string" || spec.workspaceId === "") {
			await this.ensureWorkspaceAndKeep(spec).catch(() => undefined);
		}
		const current = this.allSpecs().get(environment) ?? spec;
		await this.ensureTunnel(current).catch(() => undefined);
		await this.clientFor(environment)?.sessions().catch(() => undefined);
		return this.environments();
	}

	/** List sessions of one environment. Returns `{ items }`; failures surface as Remote errors. */
	async sessions(environment) {
		await this.ready;
		const spec = this.allSpecs().get(environment);
		if (spec === undefined) throw new Error(`dsh-control: unknown environment ${JSON.stringify(environment)}`);
		await this.ensureTunnel(spec);
		const result = await this.clientFor(environment).sessions();
		if (result.ok === false) throw new Error(result.error?.message ?? "无法读取该环境的会话");
		return result.value;
	}

	/**
	 * Scenario 2 — read one remote session's history (cold read, no live stream).
	 * Returns `{ items }` where each item is `{ role, text }` in chronological order.
	 */
	async sessionHistory(environment, remoteSessionId) {
		await this.ready;
		const spec = this.allSpecs().get(environment);
		if (spec === undefined) throw new Error(`dsh-control: unknown environment ${JSON.stringify(environment)}`);
		await this.ensureTunnel(spec).catch(() => undefined);
		const client = this.clientFor(environment);
		// Get the cursor first.
		const list = await client.call("session/list", { _request: {} });
		if (list.ok === false) throw new Error(list.error?.message ?? "无法读取会话列表");
		const item = (list.value?.items ?? []).find((row) => row.sessionId === remoteSessionId);
		if (item === undefined) throw new Error("远端会话不见了");
		const cursor = item.projections?.asOfSeq;
		if (typeof cursor !== "number") throw new Error("拿不到远端会话的日志游标");
		// Read the page.
		const page = await client.call("session/page", {
			request: { address: { kind: "session", sessionId: remoteSessionId }, throughSeq: cursor, maxMessages: 100 },
		});
		if (page.ok === false) throw new Error(page.error?.message ?? "读取远端历史失败");
		// The visible conversation is decided by one pure, unit-tested rule.
		const { historyItemsFromRecords } = await import("./messages.js");
		return { items: historyItemsFromRecords(page.value?.records) };
	}

	/**
	 * Scenario 2 — send a message to a remote session (take over).
	 * Returns when the remote turn completes, with the reply text.
	 */
	async sendToSession(environment, remoteSessionId, text) {
		await this.ready;
		const spec = this.allSpecs().get(environment);
		if (spec === undefined) throw new Error(`dsh-control: unknown environment ${JSON.stringify(environment)}`);
		await this.ensureTunnel(spec).catch(() => undefined);
		const client = this.clientFor(environment);
		const { runRemoteTurn } = await import("./remote-turn.js");
		const turn = await runRemoteTurn(client, remoteSessionId, text, {});
		if (turn.ok === false) throw new Error(turn.error ?? "发送失败");
		return { text: turn.text };
	}

	/** Manual fallback material: tunnel command + the (short) remote paragraph. */
	async setupSteps(sshTarget, name, remotePort) {
		await this.ready;
		if (typeof sshTarget !== "string" || sshTarget.trim() === "") {
			return { error: "请填写服务器地址（形如 user@1.2.3.4）" };
		}
		const target = sshTarget.trim();
		const resolvedName = typeof name === "string" && name.trim() !== "" ? name.trim() : suggestName(target);
		if (!/^[\w.-]+$/.test(resolvedName)) return { error: "名称只能包含字母、数字、点、下划线、连字符" };
		const localPort = await pickFreePort();
		const resolvedRemotePort = positiveInt(remotePort, DEFAULT_REMOTE_PORT);
		const spec = { name: resolvedName, sshTarget: target, localPort, remotePort: resolvedRemotePort };
		return {
			name: resolvedName,
			sshTarget: target,
			localPort,
			remotePort: resolvedRemotePort,
			endpoint: `http://127.0.0.1:${localPort}`,
			tunnelCommand: buildTunnelCommand(spec),
			remoteParagraph: buildRemoteParagraph(spec),
		};
	}

	/**
	 * Direct-mode adoption: connect to a remote dsh through a domain (no SSH).
	 * The user supplies the endpoint, the dsh launch token, and optionally the
	 * Basic Auth credentials for a reverse-proxy gate in front of the domain.
	 */
	async adoptDirect(endpoint, token, name, authUser, authPassword) {
		await this.ready;
		const cleanEndpoint = String(endpoint ?? "").trim().replace(/\/+$/, "");
		if (!/^https?:\/\//.test(cleanEndpoint)) {
			return { error: "地址需要以 http:// 或 https:// 开头" };
		}
		const cleanToken = String(token ?? "").trim();
		if (cleanToken.length < 20) {
			return { error: "访问令牌太短（应为一串 20 字符以上的随机字符）" };
		}
		const environmentName = (String(name ?? "").trim() || new URL(cleanEndpoint).hostname).replace(/[^\w.-]/g, "-");
		if (!/^[\w.-]+$/.test(environmentName)) {
			return { error: "名称只能包含字母、数字、点、下划线、连字符" };
		}
		// Basic Auth for the reverse-proxy gate (optional).
		let authHeader;
		if (authUser !== undefined && String(authUser).trim() !== "") {
			const encoded = Buffer.from(`${String(authUser).trim()}:${String(authPassword ?? "")}`).toString("base64");
			authHeader = `Basic ${encoded}`;
		}
		const spec = {
			name: environmentName,
			endpoint: cleanEndpoint,
			token: cleanToken,
			...(authHeader !== undefined ? { authHeader } : {}),
		};
		// Verify: exchange token for cookie, list sessions.
		const client = new RemoteDsh(spec);
		const probe = await client.sessions();
		if (probe.ok === false) {
			return { error: `连不上：${probe.error?.message ?? "未知原因"}`, name: environmentName };
		}
		this.runtimeEnvironments.set(environmentName, spec);
		this.clients.delete(environmentName);
		await this.saveState();
		const workspace = await this.ensureWorkspaceAndKeep(spec);
		return {
			name: environmentName,
			sessions: probe.value.items.length,
			workspace: workspace.ok === true ? { path: workspace.path, created: workspace.created === true } : undefined,
			workspaceError: workspace.ok === true ? undefined : workspace.error,
		};
	}

	/**
	 * Manual fallback acceptance: the pasted token plus the tunnel parameters
	 * from {@link setupSteps}; verifies and goes live.
	 */
	async adopt(input, name, sshTarget, localPort, remotePort) {
		await this.ready;
		const resolvedLocalPort = positiveInt(localPort, undefined);
		const parsed = parseConnectBlock(String(input ?? ""), {
			name: typeof name === "string" && name.trim() !== "" ? name.trim() : undefined,
			localPort: resolvedLocalPort,
			remotePort: positiveInt(remotePort, DEFAULT_REMOTE_PORT),
		});
		if (parsed.error !== undefined) return { error: parsed.error };

		const environmentName = parsed.name ?? suggestName(sshTarget ?? "");
		if (typeof environmentName !== "string" || !/^[\w.-]+$/.test(environmentName)) {
			return { error: "名称只能包含字母、数字、点、下划线、连字符" };
		}
		const localPortValue = resolvedLocalPort ?? parsed.localPort;
		const spec = {
			name: environmentName,
			endpoint: parsed.endpoint ?? (localPortValue === undefined ? undefined : `http://127.0.0.1:${localPortValue}`),
			token: parsed.token,
			remotePort: parsed.remotePort ?? DEFAULT_REMOTE_PORT,
			...(localPortValue === undefined ? {} : { localPort: localPortValue }),
			...(typeof sshTarget === "string" && sshTarget !== "" ? { sshTarget } : {}),
		};
		if (typeof spec.sshTarget === "string" && spec.localPort !== undefined) {
			await this.tunnels.ensure({
				name: environmentName,
				target: spec.sshTarget,
				localPort: spec.localPort,
				remotePort: spec.remotePort,
			});
		}
		this.runtimeEnvironments.set(environmentName, spec);
		await this.saveState();
		this.clients.delete(environmentName);
		const probe = await this.clientFor(environmentName).sessions();
		if (probe.ok === false) {
			return { error: `已保存，但连接验证未通过：${probe.error?.message ?? probe.error}`, name: environmentName };
		}
		// The manual path earns the same result as the one-click path.
		const workspace = await this.ensureWorkspaceAndKeep(this.runtimeEnvironments.get(environmentName) ?? spec);
		return {
			name: environmentName,
			sessions: probe.value.items.length,
			workspace: workspace.ok === true ? { path: workspace.path, created: workspace.created === true } : undefined,
			workspaceError: workspace.ok === true ? undefined : workspace.error,
		};
	}

	/** Remove an environment that was added through the UI. */
	async removeEnvironment(name) {
		const mount = this.proxyMounts.get(name);
		if (mount !== undefined) { try { mount.dispose(); } catch { /* gone */ } this.proxyMounts.delete(name); }
		await this.ready;
		const spec = this.runtimeEnvironments.get(name) ?? this.allSpecs().get(name);
		if (!this.runtimeEnvironments.has(name)) {
			return { error: this.configEnvironments().some((entry) => entry?.name === name)
				? "该环境在配置文件中声明，请在配置里移除"
				: `没有名为 ${JSON.stringify(name)} 的环境` };
		}
		this.tunnels.stop(name);
		await this.dropWorkspace(spec ?? {});
		this.runtimeEnvironments.delete(name);
		this.clients.delete(name);
		await this.saveState();
		return { removed: name };
	}

	/**
	 * Same-origin URL that serves the environment's own dsh GUI through the
	 * local web server (reverse proxy over the tunnel; credentials stay
	 * server-side). Mounts lazily, one unguessable path per process.
	 */
	async proxyUrl(environment) {
		await this.ready;
		const spec = this.allSpecs().get(environment);
		if (spec === undefined) throw new Error(`dsh-control: unknown environment ${JSON.stringify(environment)}`);
		const started = Date.now();
		await this.ensureTunnel(spec);
		const tunnelMs = Date.now() - started;
		const client = this.clientFor(environment);
		const authStarted = Date.now();
		const fresh = await client.ensureCookie();
		const authMs = Date.now() - authStarted;
		this.diag({ kind: "proxyUrl", tunnelMs, authMs, totalMs: Date.now() - started });
		if (fresh !== true) throw new Error(client.lastDetail ?? "远端鉴权失败，请重连该环境");
		const server = typeof this.ctx.get === "function" ? this.ctx.get("webServer") : this.ctx.webServer;
		if (server === undefined || typeof server.register !== "function") throw new Error("本地 web 服务不可用");
		const authority = typeof server.port === "number" ? `127.0.0.1:${server.port}` : undefined;
		let mount = this.proxyMounts.get(environment);
		if (mount === undefined) {
			mount = mountEnvironmentProxy(server, environment, () => this.clientFor(environment), { authority });
			this.proxyMounts.set(environment, mount);
		}
		// Relative on purpose: the frame must share the shell's scheme, because a
		// cross-scheme frame cannot open the stream WebSocket in the desktop app.
		// The served page injects an absolute `streamBaseUrl` so the socket goes
		// to the real http authority while the document keeps the shell's origin.
		return { url: `${mount.prefix}/` };
	}

	/** Client-side diagnostics for the proxied iframe (appended to proxy.log). */
	async diag(info) {
		await this.ready;
		const { appendFileSync, statSync, truncateSync } = await import("node:fs");
		const { homedir } = await import("node:os");
		const { join } = await import("node:path");
		try {
			const dir = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "dsh-control");
			const file = join(dir, "proxy.log");
			try { if (statSync(file).size > 256 * 1024) truncateSync(file, 0); } catch { /* first write */ }
			appendFileSync(file, `${new Date().toISOString()} DIAG ${JSON.stringify(info ?? {}).slice(0, 800)}\n`);
		} catch { /* diagnostics never break anything */ }
		return { ok: true };
	}

	/** Authenticated URL that opens the environment's own dsh interface. */
	async openWebUrl(environment) {
		await this.ready;
		const spec = this.allSpecs().get(environment);
		if (spec === undefined) throw new Error(`dsh-control: unknown environment ${JSON.stringify(environment)}`);
		await this.ensureTunnel(spec).catch(() => undefined);
		const base = typeof spec.endpoint === "string" ? spec.endpoint : "";
		// The launch token rotates on every remote dsh restart while the session
		// cookie (durable signing secret) stays valid — the panel can look
		// connected while the stored token is stale and the iframe gets a 401.
		// Re-probe the current token over SSH before building the URL.
		let token = spec.token;
		if (typeof spec.sshTarget === "string" && spec.sshTarget !== "") {
			try {
				const probe = await runSsh(spec.sshTarget, buildProbeScript(), { timeoutMs: 15_000 });
				const report = parseRemoteReport(probe.stdout);
				if (typeof report.token === "string" && report.token !== "") {
					if (report.token !== spec.token) {
						token = report.token;
						spec.token = token;
						this.clients.delete(spec.name); // force a fresh client with the new token
						await this.saveState();
					}
				}
			} catch { /* keep the stored token; the cookie may still work */ }
		}
		if (typeof token !== "string" || token === "") return { url: base };
		return { url: `${base}/?token=${encodeURIComponent(token)}` };
	}
}

for (const method of ["environments", "refresh", "reconnect", "sessions", "connect", "setupSteps", "adopt", "removeEnvironment", "openWebUrl", "diagnostics", "remoteSessions", "adoptDirect", "sessionHistory", "sendToSession", "proxyUrl", "diag"]) {
	markRemote(DshControlService, method);
}

export { DshControlService, DshControlService as default };

function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}

function positiveInt(value, fallback) {
	const n = Number(value);
	return Number.isSafeInteger(n) && n > 0 && n <= 65535 ? n : fallback;
}

/** Pick a currently free loopback port. */
async function pickFreePort() {
	return await new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : undefined;
			server.close(() => {
				if (typeof port === "number") resolve(port);
				else reject(new Error("dsh-control: could not allocate a local port"));
			});
		});
	});
}

/** Reuse a remembered port when it is still free; otherwise allocate a new one. */
async function reserveLocalPort(remembered) {
	if (Number.isSafeInteger(remembered) && remembered > 0 && await isPortFree(remembered)) return remembered;
	return await pickFreePort();
}

function isPortFree(port) {
	return new Promise((resolve) => {
		const server = createServer();
		server.unref();
		server.once("error", () => resolve(false));
		server.listen(port, "127.0.0.1", () => {
			server.close(() => resolve(true));
		});
	});
}

/** Existence predicate handed to the workspace-naming helper. */
async function pathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** The active dsh home (where profiles, sessions and our state live). */
function dshHome() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}
