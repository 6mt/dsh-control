/**
 * Unit tests for the tunnel keeper's adopted-listener rule (lib/tunnel.js).
 *
 * Invariant: a tunnel this process spawned reports its own death, but an
 * *adopted* listener (left behind by a previous run) dies silently. ensure()
 * must re-verify an adopted port on every call and respawn when it vanished —
 * otherwise every request hits a dead port (ECONNREFUSED) and 重连 loops on
 * the same stale "adopted" flag.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { TunnelManager } from "../lib/tunnel.js";

function listen(port) {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve(server));
	});
}

const close = (server) => new Promise((resolve) => server.close(resolve));

test("an adopted listener is re-verified on every ensure()", async () => {
	const port = 53981;
	const server = await listen(port);
	const manager = new TunnelManager();
	let spawns = 0;
	// The real spawn needs ssh; the rule under test is the bookkeeping around it.
	manager.spawnEntry = () => { spawns += 1; return { ok: true }; };
	const spec = { name: "t", target: "user@invalid.invalid", localPort: port, remotePort: 3080 };

	// First ensure: the port is serving → adopted, no spawn of our own.
	const first = await manager.ensure(spec);
	assert.equal(first.ok, true);
	assert.equal(spawns, 0, "a serving port is adopted, not spawned");

	// The adopted listener dies silently (we own no process to hear about it).
	await close(server);

	// Second ensure must NOTICE and fall through to spawning a replacement.
	const second = await manager.ensure(spec);
	assert.equal(second.ok, true);
	assert.equal(spawns, 1, "a vanished adopted listener must trigger a respawn");
});

test("an adopted listener that keeps serving is not respawned", async () => {
	const port = 53982;
	const server = await listen(port);
	const manager = new TunnelManager();
	let spawns = 0;
	manager.spawnEntry = () => { spawns += 1; return { ok: true }; };
	const spec = { name: "t2", target: "user@invalid.invalid", localPort: port, remotePort: 3080 };

	await manager.ensure(spec);
	await manager.ensure(spec);
	await manager.ensure(spec);
	assert.equal(spawns, 0, "a live adopted listener must not be replaced");
	await close(server);
});
