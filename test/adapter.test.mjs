/**
 * Unit tests for the remote adapter's pure decisions (lib/messages.js).
 * The adapter class imports runtime packages, so its wiring is covered by the
 * sandbox acceptance run instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { latestUserText, carriesUserTurn, titleFromRequest } from "../lib/messages.js";

test("the person's own message is forwarded, not the injected runtime context", () => {
	const messages = [
		{ role: "system", content: [{ type: "text", text: "sys" }] },
		{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "只回复四个字：链路已通" }] },
		{ role: "user", source: { kind: "runtime-context" }, content: [{ type: "text", text: "Current runtime context. This snapshot supersedes…" }] },
	];
	assert.equal(latestUserText(messages), "只回复四个字：链路已通");
});

test("sources that are absent are still treated as user text", () => {
	const messages = [{ role: "user", content: [{ type: "text", text: "老投影没有 source" }] }];
	assert.equal(latestUserText(messages), "老投影没有 source");
});

test("a machine-generated request carries no user turn", () => {
	const titleRequest = [{
		role: "user",
		source: { kind: "dsh-session-title-llm" },
		content: [{ type: "text", text: 'Generate the session title from this JSON array of human messages:\n[{"seq":9,"text":"你好"}]' }],
	}];
	assert.equal(carriesUserTurn(titleRequest), false);
	assert.equal(latestUserText(titleRequest), undefined);
});

test("session titles are answered locally from the title request", () => {
	const prompt = 'Generate the session title from this JSON array of human messages:\n[{"seq":9,"text":"帮我看看远程服务器上的会话"}]\nReturn only the title.';
	assert.equal(titleFromRequest(prompt), "帮我看看远程服务器上的会话");
});

test("a long title is truncated and decoded escapes survive", () => {
	const prompt = '[{"text":"这是一个非常非常非常非常非常非常长的会话标题需要被截断"}]';
	const title = titleFromRequest(prompt);
	assert.ok(title.endsWith("…"));
	assert.ok([...title].length <= 25);
	assert.equal(titleFromRequest('{"text":"带\\"引号\\"的标题"}'), '带"引号"的标题');
	assert.equal(titleFromRequest("no json here"), undefined);
	assert.equal(titleFromRequest(undefined), undefined);
});

test("mixed content parts still yield the text", () => {
	assert.equal(
		latestUserText([{ role: "user", source: { kind: "user" }, content: [{ type: "image", data: "x" }, { type: "text", text: "看图" }] }]),
		"看图",
	);
});

// --- channel preparation (a pure helper, so this needs no runtime packages) ---
import { prepareRemoteChannel } from "../lib/channel.js";

test("the tunnel is ensured before the connection is used", async () => {
	// Field failure: after a dsh restart the first remote turn died with
	// "连接被拒绝（本地隧道未启动？）" because nothing had started the tunnel yet.
	const order = [];
	const prepared = await prepareRemoteChannel("box", {
		ensureChannel: async (environment) => { order.push(`ensure:${environment}`); return { ok: true }; },
		connectionFor: (environment) => { order.push(`connect:${environment}`); return { call() {} }; },
	});
	assert.equal(prepared.ok, true);
	assert.deepEqual(order, ["ensure:box", "connect:box"], "ensure happens first, then lookup");
});

test("a failed ensure stops the turn with that reason (no connection attempt)", async () => {
	let looked = false;
	const prepared = await prepareRemoteChannel("box", {
		ensureChannel: async () => ({ ok: false, error: "隧道未建立或实例不可达：连接被拒绝（本地隧道未启动？）" }),
		connectionFor: () => { looked = true; return {}; },
	});
	assert.equal(prepared.ok, false);
	assert.match(prepared.error, /隧道未建立|连接被拒绝/);
	assert.equal(looked, false, "must not touch the connection when the tunnel is down");
});

test("an ensure that throws is reported, not swallowed", async () => {
	const prepared = await prepareRemoteChannel("box", {
		ensureChannel: async () => { throw new Error("ssh: permission denied"); },
		connectionFor: () => ({}),
	});
	assert.equal(prepared.ok, false);
	assert.match(prepared.error, /permission denied/);
});

test("a missing connection is reported with the environment name", async () => {
	const prepared = await prepareRemoteChannel("box", { connectionFor: () => undefined });
	assert.equal(prepared.ok, false);
	assert.match(prepared.error, /box/);
});
