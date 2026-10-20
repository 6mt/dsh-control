/**
 * SSH tunnel keeper.
 *
 * Product decision (see README): the remote dsh itself is long-lived; the
 * local-to-remote channel is owned by the plugin — started lazily the first
 * time an environment is needed, kept open afterwards (live session data needs
 * a long connection), reconnected automatically when the network drops, and
 * closed when the plugin unloads or the environment is removed.
 *
 * A dead tunnel is invisible by design: the next call to ensure() restarts it.
 */
import { spawn } from "node:child_process";
import { createConnection } from "node:net";

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

// Backstop only: ensure() and the proxy's recovery hook handle the fast path.
const WATCH_INTERVAL_MS = 60_000;

export class TunnelManager {
	/**
	 * @param options.spawnTunnel - injectable spawner (tests use a fake one)
	 * @param options.onEvent - (event) => void, for host-side diagnostics
	 * @param options.watchMs - supervisor interval (tests shorten it)
	 */
	constructor(options = {}) {
		this.entries = new Map(); // name -> entry
		this.spawnTunnel = options.spawnTunnel ?? ((spec, args) => spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] }));
		this.onEvent = options.onEvent ?? (() => {});
		this.watchMs = options.watchMs ?? WATCH_INTERVAL_MS;
		this.watchTimer = undefined;
	}

	/** Supervise live tunnels: a half-dead ssh (process alive, listener gone) is
	 *  invisible to the child's close handler, so probe the port ourselves and
	 *  rebuild immediately instead of waiting for the user to hit 重连. */
	startWatching() {
		if (this.watchTimer !== undefined) return;
		this.watchTimer = setInterval(() => {
			for (const [name, entry] of this.entries) {
				if (entry.stopped === true || entry.checking === true) continue;
				entry.checking = true;
				waitForPort(entry.spec.localPort, 300).then((alive) => {
					entry.checking = false;
					if (entry.stopped === true || alive) return;
					// A listener that dies was either adopted (we never owned the
					// process) or came from a child that is still running.
					this.onEvent({ event: "tunnel-dead", name, port: entry.spec.localPort });
					try { entry.child?.kill("SIGTERM"); } catch { /* gone */ }
					entry.child = undefined;
					entry.adopted = false;
					if (entry.timer !== undefined) clearTimeout(entry.timer);
					entry.timer = undefined;
					// A tunnel that stayed up for a while earns a fresh backoff.
					if (entry.upSince !== undefined && Date.now() - entry.upSince > 60_000) entry.restarts = 0;
					entry.restarts += 1;
					entry.lastError = "通道断开（自动重建）";
					this.onEvent({ event: "tunnel-restart", name, port: entry.spec.localPort, attempt: entry.restarts });
					void this.spawnEntry(entry);
				});
			}
		}, this.watchMs);
		this.watchTimer.unref?.();
	}

	stopWatching() {
		if (this.watchTimer === undefined) return;
		clearInterval(this.watchTimer);
		this.watchTimer = undefined;
	}

	/** Status snapshot for the UI (no secrets). */
	status(name) {
		const entry = this.entries.get(name);
		if (entry === undefined) return { running: false, restarts: 0 };
		return {
			running: entry.adopted === true || (entry.child !== undefined && entry.stopped !== true),
			adopted: entry.adopted === true,
			localPort: entry.spec.localPort,
			remotePort: entry.spec.remotePort,
			restarts: entry.restarts,
			lastError: entry.lastError ?? null,
		};
	}

	/**
	 * Make sure a tunnel to this environment exists and accepts connections.
	 * Restarts a stale tunnel, and waits until the local port actually accepts.
	 * @returns {{ok: true} | {ok: false, error: string}}
	 */
	async ensure(spec) {
		const existing = this.entries.get(spec.name);
		const live = existing !== undefined && sameSpec(existing.spec, spec) && existing.stopped !== true
			&& (existing.adopted === true || existing.child !== undefined);
		if (live) {
			// Never trust bookkeeping: an ssh process can stay alive while its -L
			// listener is gone (network change, sleep/wake, remote restart). Every
			// ensure() therefore probes the port — it only runs on user actions or
			// after a failed request, so the extra loopback connect is free.
			if (await waitForPort(spec.localPort, 300)) return { ok: true };
			this.stop(spec.name);
		}
		if (existing !== undefined) this.stop(spec.name);

		// A port that already serves locally is adopted as-is: it is either a
		// tunnel left behind by a previous run of this plugin or another listener
		// on the same port. The caller's HTTP verification decides which.
		if (await waitForPort(spec.localPort, 300)) {
			this.entries.set(spec.name, {
				spec,
				child: undefined,
				stopped: false,
				adopted: true,
				restarts: 0,
				lastError: undefined,
				timer: undefined,
				upSince: Date.now(),
			});
			this.startWatching();
			return { ok: true };
		}

		const entry = {
			spec,
			child: undefined,
			stopped: false,
			restarts: 0,
			lastError: undefined,
			timer: undefined,
		};
		this.entries.set(spec.name, entry);
		this.startWatching();
		return await this.spawnEntry(entry);
	}

	spawnEntry(entry) {
		const { spec } = entry;
		const args = [
			"-N",
			"-L", `127.0.0.1:${spec.localPort}:127.0.0.1:${spec.remotePort}`,
			"-o", "BatchMode=yes",
			"-o", "StrictHostKeyChecking=accept-new",
			"-o", "ExitOnForwardFailure=yes",
			"-o", "ServerAliveInterval=15",
			"-o", "ServerAliveCountMax=3",
			...(spec.sshOptions ?? []),
			spec.target,
		];
		let child;
		try {
			child = this.spawnTunnel(spec, args);
		} catch (error) {
			entry.lastError = errorText(error);
			return { ok: false, error: entry.lastError };
		}
		entry.child = child;
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr = `${stderr}${String(chunk)}`.slice(-2_000);
		});
		child.on("error", (error) => {
			entry.lastError = errorText(error);
		});
		child.on("close", () => {
			entry.child = undefined;
			if (entry.stopped === true) return;
			// A previous run may have left a tunnel listening on this port (the host
			// process was killed before it could clean up). If the port is still
			// serving, adopt it instead of restart-looping against the bind error;
			// the caller's HTTP verification decides whether it reaches the right dsh.
			const bindConflict = /Address already in use|cannot listen to port|Could not request local forwarding/i.test(stderr);
			if (bindConflict) {
				entry.timer = setTimeout(() => {
					entry.timer = undefined;
					if (entry.stopped === true) return;
					waitForPort(spec.localPort, 1_000).then((serving) => {
						if (entry.stopped === true) return;
						if (serving) {
							entry.adopted = true;
							entry.lastError = undefined;
							return;
						}
						entry.restarts += 1;
						this.spawnEntry(entry);
					});
				}, 300);
				entry.timer.unref?.();
				return;
			}
			entry.lastError = stderr.trim() === "" ? "通道断开" : stderr.trim();
			entry.restarts += 1;
			const delay = RECONNECT_DELAYS_MS[Math.min(entry.restarts - 1, RECONNECT_DELAYS_MS.length - 1)];
			entry.timer = setTimeout(() => {
				entry.timer = undefined;
				if (entry.stopped !== true) this.spawnEntry(entry);
			}, delay);
			entry.timer.unref?.();
		});
		return waitForPort(spec.localPort).then((ready) => {
			if (ready) {
				entry.upSince = Date.now();
				this.onEvent({ event: "tunnel-up", name: entry.spec.name, port: spec.localPort });
				return { ok: true };
			}
			return { ok: false, error: entry.lastError ?? "通道没有就绪" };
		});
	}

	stop(name) {
		const entry = this.entries.get(name);
		if (entry === undefined) return;
		entry.stopped = true;
		if (entry.timer !== undefined) clearTimeout(entry.timer);
		entry.timer = undefined;
		try {
			entry.child?.kill("SIGTERM");
		} catch { /* already gone */ }
		entry.child = undefined;
		this.entries.delete(name);
	}

	disposeAll() {
		for (const name of [...this.entries.keys()]) this.stop(name);
		this.stopWatching();
	}
}

/** Wait until a loopback port accepts a TCP connection. */
export function waitForPort(port, timeoutMs = 6_000, intervalMs = 200) {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve) => {
		const attempt = () => {
			const socket = createConnection({ host: "127.0.0.1", port });
			const done = (ok) => {
				socket.removeAllListeners();
				socket.destroy();
				if (ok) resolve(true);
				else if (Date.now() >= deadline) resolve(false);
				else setTimeout(attempt, intervalMs).unref?.();
			};
			socket.once("connect", () => done(true));
			socket.once("error", () => done(false));
			socket.setTimeout(1_000, () => done(false));
		};
		attempt();
	});
}

function sameSpec(left, right) {
	return left.target === right.target
		&& left.localPort === right.localPort
		&& left.remotePort === right.remotePort;
}

function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}
