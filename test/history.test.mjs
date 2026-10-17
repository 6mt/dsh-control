/**
 * Unit tests for the visible-conversation rule (lib/messages.js).
 *
 * The remote session log contains helper turns the user never typed —
 * runtime-context, time-context, title requests — recorded as user messages.
 * Only `source.kind === "user"` may surface in the conversation view; that
 * single rule must hold for every kind the remote can inject.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { historyItemsFromRecords } from "../lib/messages.js";

const userMessage = (text, kind = "user") => ({
	event: {
		type: "user/message",
		data: { source: { kind }, content: [{ type: "text", text }] },
	},
});

const assistantMessage = (text) => ({
	event: {
		type: "assistant/message",
		data: { message: { content: [{ type: "text", text }] } },
	},
});

test("user and assistant messages appear in order", () => {
	const items = historyItemsFromRecords([
		userMessage("你好"),
		assistantMessage("你好，有什么可以帮你？"),
		userMessage("再问一件事"),
	]);
	assert.deepEqual(items, [
		{ role: "user", text: "你好" },
		{ role: "assistant", text: "你好，有什么可以帮你？" },
		{ role: "user", text: "再问一件事" },
	]);
});

test("injected helper turns never surface (runtime-context / time-context / title)", () => {
	const items = historyItemsFromRecords([
		userMessage("Time sampled while preparing turn 8", "time-context"),
		userMessage("system context block", "runtime-context"),
		userMessage("起个标题", "dsh-session-title-llm"),
		userMessage("真实提问"),
		assistantMessage("回答"),
	]);
	assert.deepEqual(items, [
		{ role: "user", text: "真实提问" },
		{ role: "assistant", text: "回答" },
	]);
});

test("unknown injected kinds stay hidden too (whitelist, not a blacklist)", () => {
	const noSource = {
		event: { type: "user/message", data: { content: [{ type: "text", text: "无 source 的消息" }] } },
	};
	const items = historyItemsFromRecords([
		userMessage("某种新的注入", "whatever-new-kind"),
		noSource,
		assistantMessage("回复"),
	]);
	// A message without a source is not confirmed user-typed: keep it hidden.
	assert.deepEqual(items, [{ role: "assistant", text: "回复" }]);
});

test("empty text parts are skipped and malformed records are tolerated", () => {
	const items = historyItemsFromRecords([
		userMessage(""),
		assistantMessage(""),
		null,
		{ event: { type: "session/title" } },
		userMessage("有内容"),
	]);
	assert.deepEqual(items, [{ role: "user", text: "有内容" }]);
});
