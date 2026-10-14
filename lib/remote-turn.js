/**
 * One remote conversation turn.
 *
 * Drives a session living on a remote dsh environment through the verified web
 * API and returns the assistant's reply text:
 *
 *   session/prompt { requestId, sessionId, mode:'queue', content:[{type:'text',text}] }
 *     -> { accepted: true }                      (the turn starts on the remote)
 *   session/follow (WebSocket)                   -> live assistant text deltas
 *   session/list   -> poll until `running` is false      (fallback)
 *   session/page   -> read the durable reply             (fallback)
 *
 * Streaming is preferred because the remote may spend minutes inside tools;
 * without it the local Session shows nothing until the whole turn finished.
 * Every streaming failure degrades to the polling path instead of failing the
 * turn.
 *
 * Shapes come from the generated declarations in
 * @deepseek-ai/dsh-api-session-controller (lib/typert.host.js) and were
 * confirmed against a live remote environment during development.
 */
import { textDeltaOf, chunkText } from "./mux.js";

const POLL_INTERVAL_MS = 1_500;
const TURN_TIMEOUT_MS = 10 * 60_000;
const IDLE_GRACE_MS = 3_000;

/**
 * Send one user message and wait for the remote turn to finish.
 *
 * @param connection - remote connection with `call` and (optionally) `follow`.
 * @param sessionId - the remote Session receiving this turn.
 * @param text - the user's message.
 * @param options.onDelta - called with text as it arrives.
 * @returns `{ok:true, text, streamed?}` — `text` is the authoritative reply, and
 *   whatever `onDelta` already received is a prefix of it.
 */
export async function runRemoteTurn(connection, sessionId, text, options = {}) {
	const { pollIntervalMs = POLL_INTERVAL_MS, timeoutMs = TURN_TIMEOUT_MS, idleGraceMs = IDLE_GRACE_MS, signal, onDelta } = options;
	const prompt = await connection.call("session/prompt", {
		request: {
			requestId: `dshctl-${crypto.randomUUID()}`,
			sessionId,
			mode: "queue",
			content: [{ type: "text", text }],
		},
	});
	if (prompt.ok === false) {
		return { ok: false, error: prompt.error?.message ?? "远端拒绝了这条消息" };
	}

	// Preferred path: follow the live stream.
	if (typeof connection.follow === "function") {
		const streamed = await streamTurn(connection, sessionId, { onDelta, signal, timeoutMs });
		if (streamed.ok === true && streamed.text.trim() !== "") {
			return { ok: true, text: streamed.text, streamed: true };
		}
		if (streamed.aborted === true) return { ok: false, error: "已取消" };
		// Any other streaming failure falls through to polling below.
	}

	const polled = await pollUntilIdle(connection, sessionId, { pollIntervalMs, timeoutMs, idleGraceMs, signal });
	if (polled.ok === false) return polled;
	const reply = await readLastAssistantText(connection, sessionId, polled.cursor);
	if (reply.ok === false) return reply;
	return { ok: true, text: reply.text };
}

/**
 * Follow the remote Session's assistant stream until its turn ends.
 * @returns `{ok:true, text}` when text arrived, `{ok:false, aborted?, error?}` otherwise.
 */
async function streamTurn(connection, sessionId, { onDelta, signal, timeoutMs }) {
	let text = "";
	const deadline = Date.now() + timeoutMs;
	const push = (piece) => {
		text += piece;
		onDelta?.(piece);
	};
	try {
		const frames = connection.follow({ address: { kind: "session", sessionId }, assistantStream: true }, { signal });
		for await (const frame of frames) {
			if (Date.now() > deadline) break;
			if (frame?.type === "snapshot") {
				// A late subscriber receives the attempt already in flight replayed.
				for (const chunk of frame.assistantStream?.activeAttempt?.stream ?? []) {
					const delta = chunkText(chunk);
					if (delta !== undefined) push(delta.text);
				}
				continue;
			}
			const delta = textDeltaOf(frame);
			if (delta !== undefined) {
				push(delta.text);
				continue;
			}
			if (frame?.type === "event" && frame.event?.type === "turn/end") break;
		}
	} catch (error) {
		if (signal?.aborted === true) return { ok: false, aborted: true, text };
		// A broken stream is not a broken turn: polling can still read the result.
		return text === "" ? { ok: false, error: errorText(error) } : { ok: true, text };
	}
	if (text === "") return { ok: false, error: "远端这一轮没有流式输出" };
	return { ok: true, text };
}

/** Wait for the remote Session to report idle, carrying its cursor forward. */
async function pollUntilIdle(connection, sessionId, { pollIntervalMs, timeoutMs, idleGraceMs, signal }) {
	const deadline = Date.now() + timeoutMs;
	// The remote turn begins asynchronously: wait until it reports running, then
	// until it reports idle. A fast turn may never be observed as running, so a
	// short grace period also counts as finished.
	let sawRunning = false;
	let cursor;
	while (Date.now() < deadline) {
		if (signal?.aborted === true) {
			await connection.call("session/cancel", { request: { sessionId } }).catch(() => undefined);
			return { ok: false, error: "已取消" };
		}
		const list = await connection.call("session/list", { _request: {} });
		if (list.ok === true) {
			const item = (list.value?.items ?? []).find((row) => row.sessionId === sessionId);
			if (item === undefined) return { ok: false, error: "远端会话不见了" };
			if (typeof item.projections?.asOfSeq === "number") cursor = item.projections.asOfSeq;
			if (item.running === true) sawRunning = true;
			// A turn that starts and ends between two polls is never seen running;
			// after the grace period an idle session counts as finished.
			else if (sawRunning || Date.now() > deadline - timeoutMs + idleGraceMs) break;
		}
		await delay(pollIntervalMs);
	}
	return { ok: true, cursor };
}

/**
 * Read the newest assistant message text from the remote session history.
 * @param throughSeq - inclusive log cursor (the projection's `asOfSeq`).
 */
export async function readLastAssistantText(connection, sessionId, throughSeq) {
	if (typeof throughSeq !== "number" || throughSeq < 0) {
		return { ok: false, error: "拿不到远端会话的日志游标" };
	}
	const page = await connection.call("session/page", {
		request: {
			address: { kind: "session", sessionId },
			throughSeq,
			maxMessages: 20,
		},
	});
	if (page.ok === false) {
		return { ok: false, error: page.error?.message ?? "读取远端会话历史失败" };
	}
	const records = page.value?.records ?? [];
	const events = records.map((record) => record.event ?? record).filter((event) => event !== undefined);
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const text = assistantTextOf(events[index]);
		if (text !== undefined && text !== "") return { ok: true, text };
	}
	return { ok: false, error: "远端这一轮没有产生文本回复", records: events.length };
}

/**
 * Extract assistant text from one durable event.
 * The assistant event carries its content blocks; anything else (user message,
 * tool result, status change) yields undefined.
 */
export function assistantTextOf(event) {
	if (event === undefined || event === null) return undefined;
	const type = String(event.type ?? "");
	if (!type.startsWith("assistant/")) return undefined;
	const data = event.data ?? {};
	// Durable shape: { message: { role, content: [{type:'text',text}, …] } }
	const content = data.message?.content ?? data.content;
	if (Array.isArray(content)) {
		const text = content
			.filter((part) => part?.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("");
		return text === "" ? undefined : text;
	}
	if (typeof data.text === "string") return data.text;
	return undefined;
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}
