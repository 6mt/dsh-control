/**
 * Unit tests for the remote-turn primitive (lib/remote-turn.js).
 *
 * The network half is exercised against a live environment during development;
 * these tests pin the pure decisions: which events count as an assistant reply
 * and how its text is assembled.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantTextOf } from "../lib/remote-turn.js";

test("assistant message content blocks are joined into one text", () => {
	const event = {
		type: "assistant/message",
		seq: 7,
		data: { message: { role: "assistant", content: [{ type: "text", text: "收到" }, { type: "text", text: "了" }] } },
	};
	assert.equal(assistantTextOf(event), "收到了");
});

test("non-text blocks are skipped, not stringified", () => {
	const event = {
		type: "assistant/message",
		data: {
			message: {
				role: "assistant",
				content: [{ type: "tool-call", id: "t1" }, { type: "text", text: "done" }],
			},
		},
	};
	assert.equal(assistantTextOf(event), "done");
});

test("other event families never produce a reply", () => {
	assert.equal(assistantTextOf({ type: "user/message", data: { message: { content: [{ type: "text", text: "hi" }] } } }), undefined);
	assert.equal(assistantTextOf({ type: "tool/result", data: { text: "output" } }), undefined);
	assert.equal(assistantTextOf({ type: "turn/start", data: {} }), undefined);
	assert.equal(assistantTextOf(undefined), undefined);
	assert.equal(assistantTextOf(null), undefined);
});

test("an assistant event with only whitespace or no text yields nothing", () => {
	assert.equal(assistantTextOf({ type: "assistant/message", data: { message: { content: [] } } }), undefined);
	assert.equal(assistantTextOf({ type: "assistant/message", data: {} }), undefined);
});

test("a plain text payload still works for simpler event shapes", () => {
	assert.equal(assistantTextOf({ type: "assistant/message", data: { text: "hello" } }), "hello");
});
