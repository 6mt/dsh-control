/**
 * Unit tests for the streaming remote turn (lib/remote-turn.js + lib/mux.js).
 *
 * A fake remote connection drives every branch: live streaming, the polling
 * fallback, a stream that dies mid-turn, and cancellation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runRemoteTurn } from "../lib/remote-turn.js";
import { createChannel, textDeltaOf, chunkText } from "../lib/mux.js";

/** Build a fake remote connection from a scripted session. */
function fakeConnection(options) {
	const calls = [];
	const connection = {
		calls,
		async call(method, args) {
			calls.push({ method, args });
			if (method === "session/prompt") return { ok: true, value: { accepted: true } };
			if (method === "session/list") {
				return { ok: true, value: { items: [{ sessionId: "s1", running: options.running === true, projections: { asOfSeq: 20 } }] } };
			}
			if (method === "session/page") {
				return { ok: true, value: { records: [{ event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: options.pageText ?? "整段回复" }] } } } }] } };
			}
			if (method === "session/cancel") return { ok: true, value: {} };
			return { ok: false, error: { code: "x", message: `unexpected ${method}` } };
		},
	};
	if (options.follow !== undefined) connection.follow = options.follow;
	return connection;
}

function streamFrame(text) {
	return { type: "assistant-stream", frame: { type: "chunk", chunk: { type: "text-delta", index: 0, text } } };
}

test("live streaming delivers text deltas as they arrive, then finishes on turn/end", async () => {
	const deltas = [];
	const connection = fakeConnection({
		async *follow() {
			yield streamFrame("远端");
			yield streamFrame("正在干活");
			yield { type: "event", event: { type: "turn/end" } };
			yield streamFrame("（这之后的不该出现）");
		},
	});
	const result = await runRemoteTurn(connection, "s1", "问一句", { onDelta: (piece) => deltas.push(piece) });
	assert.equal(result.ok, true);
	assert.equal(result.streamed, true);
	assert.equal(result.text, "远端正在干活");
	assert.deepEqual(deltas, ["远端", "正在干活"]);
	// The prompt is still the first thing sent.
	assert.equal(connection.calls[0].method, "session/prompt");
});

test("a snapshot replays the attempt already in flight", async () => {
	const deltas = [];
	const connection = fakeConnection({
		async *follow() {
			yield {
				type: "snapshot",
				assistantStream: { activeAttempt: { stream: [{ type: "text-delta", index: 0, text: "已经说过的" }] } },
			};
			yield streamFrame("接着说的");
			yield { type: "event", event: { type: "turn/end" } };
		},
	});
	const result = await runRemoteTurn(connection, "s1", "问", { onDelta: (piece) => deltas.push(piece) });
	assert.equal(result.text, "已经说过的接着说的");
	assert.deepEqual(deltas, ["已经说过的", "接着说的"]);
});

test("without a stream the polling path reads the durable reply", async () => {
	const connection = fakeConnection({ pageText: "轮询读到的回复" });
	const result = await runRemoteTurn(connection, "s1", "问", { idleGraceMs: 0, onDelta: () => assert.fail("polling must not report deltas") });
	assert.equal(result.ok, true);
	assert.equal(result.text, "轮询读到的回复");
	assert.equal(result.streamed, undefined);
	assert.ok(connection.calls.some((call) => call.method === "session/list"));
	assert.ok(connection.calls.some((call) => call.method === "session/page"));
});

test("a stream that never produces text falls back to polling", async () => {
	const connection = fakeConnection({
		pageText: "回退读到的回复",
		async *follow() {
			yield { type: "event", event: { type: "step/start" } };
			// ends with no text at all
		},
	});
	const result = await runRemoteTurn(connection, "s1", "问", { idleGraceMs: 0 });
	assert.equal(result.ok, true);
	assert.equal(result.text, "回退读到的回复");
});

test("a broken stream keeps the text it already delivered", async () => {
	const deltas = [];
	const connection = fakeConnection({
		async *follow() {
			yield streamFrame("半句");
			throw new Error("连接断开");
		},
	});
	const result = await runRemoteTurn(connection, "s1", "问", { onDelta: (piece) => deltas.push(piece) });
	assert.equal(result.ok, true);
	assert.equal(result.text, "半句");
	assert.deepEqual(deltas, ["半句"]);
});

test("cancellation reports an abort instead of a failure", async () => {
	const controller = new AbortController();
	const connection = fakeConnection({
		async *follow() {
			controller.abort();
			throw new Error("已取消");
		},
	});
	const result = await runRemoteTurn(connection, "s1", "问", { signal: controller.signal });
	assert.equal(result.ok, false);
	assert.equal(result.error, "已取消");
});

test("a rejected prompt never opens a stream", async () => {
	let followed = false;
	const connection = fakeConnection({
		async *follow() { followed = true; },
	});
	connection.call = async (method) => method === "session/prompt"
		? { ok: false, error: { code: "x", message: "远端拒收" } }
		: { ok: true, value: {} };
	const result = await runRemoteTurn(connection, "s1", "问");
	assert.equal(result.ok, false);
	assert.equal(result.error, "远端拒收");
	assert.equal(followed, false);
});

test("reasoning deltas and non-text frames are never forwarded", () => {
	assert.equal(textDeltaOf(streamFrame("文字")).text, "文字");
	assert.equal(textDeltaOf({ type: "assistant-stream", frame: { type: "chunk", chunk: { type: "reasoning-delta", text: "思考" } } }), undefined);
	assert.equal(textDeltaOf({ type: "assistant-stream", frame: { type: "start" } }), undefined);
	assert.equal(textDeltaOf({ type: "event", event: { type: "turn/end" } }), undefined);
	assert.equal(chunkText({ type: "text-delta", text: "" }), undefined);
	assert.equal(chunkText(undefined), undefined);
});

test("the channel is total: items, termination and failure all resolve", async () => {
	const channel = createChannel();
	channel.push("a");
	assert.deepEqual(await channel.next(), { value: "a", done: false });
	const pending = channel.next();
	channel.push("b");
	assert.deepEqual(await pending, { value: "b", done: false });
	channel.end();
	assert.deepEqual(await channel.next(), { value: undefined, done: true });

	const failing = createChannel();
	const waited = failing.next();
	failing.fail(new Error("boom"));
	await assert.rejects(waited, /boom/);
});
