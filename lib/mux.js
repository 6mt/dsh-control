/**
 * WebSocket transport for dsh Remote streams.
 *
 * Unary calls travel over `POST /api/<ns>/<method>`; anything the remote *pushes*
 * (a session's live assistant stream) travels over the WebSocket mux at
 * `/api/remote.mux` with a JSON frame protocol:
 *
 *   client -> server  { type: "open", streamId, endpoint, payload: { args } }
 *                     { type: "cancel", streamId }
 *   server -> client  { type: "item", value: <frame> }
 *                     { type: "error", error: { code, message } }
 *
 * Authentication is the same signed cookie as the unary API. Node's built-in
 * `WebSocket` accepts a `headers` option, so no dependency is needed to send it.
 */

/** Minimal async queue: many producers of items, one consumer. */
export function createChannel() {
	const items = [];
	const waiters = [];
	let ended = false;
	let failure;
	return {
		push(item) {
			const waiter = waiters.shift();
			if (waiter !== undefined) waiter.resolve({ value: item, done: false });
			else items.push(item);
		},
		fail(error) {
			failure = error;
			for (const waiter of waiters.splice(0)) waiter.reject(error);
		},
		end() {
			ended = true;
			for (const waiter of waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
		},
		next() {
			if (items.length > 0) return Promise.resolve({ value: items.shift(), done: false });
			if (failure !== undefined) return Promise.reject(failure);
			if (ended) return Promise.resolve({ value: undefined, done: true });
			return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
		},
		[Symbol.asyncIterator]() {
			return this;
		},
	};
}

/**
 * Stream one Remote endpoint over the mux.
 * @param options.url - ws:// URL of `/api/remote.mux`.
 * @param options.cookie - `name=value` of the signed session cookie.
 * @param options.endpoint - Remote method path, e.g. `session/follow`.
 * @param options.args - the method's named arguments.
 * @param options.signal - abort closes the stream.
 * @param options.extraHeaders - extra headers for the upgrade (proxy gate auth).
 */
export async function* openRemoteStream(options) {
	const { url, cookie, endpoint, args, signal, WebSocketImpl = globalThis.WebSocket, extraHeaders } = options;
	if (typeof WebSocketImpl !== "function") throw new Error("当前运行时不支持 WebSocket");
	const socket = new WebSocketImpl(url, { headers: { cookie, ...extraHeaders } });
	const channel = createChannel();
	const streamId = `dshctl-${Math.random().toString(36).slice(2)}`;
	let opened = false;
	let closed = false;
	const shutdown = () => {
		if (closed) return;
		closed = true;
		try {
			if (opened) socket.send(JSON.stringify({ type: "cancel", streamId }));
		} catch { /* the socket is already gone */ }
		try {
			socket.close();
		} catch { /* already closed */ }
		channel.end();
	};

	try {
		socket.addEventListener("message", (event) => {
			let frame;
			try {
				frame = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
			} catch {
				return; // a malformed frame must not kill the stream
			}
			if (frame?.type === "item") {
				channel.push(frame.value);
				return;
			}
			if (frame?.type === "error") {
				channel.fail(new Error(frame.error?.message ?? "远程事件流返回错误"));
				shutdown();
			}
		});
		socket.addEventListener("close", () => shutdown());
		socket.addEventListener("error", () => {
			channel.fail(new Error("远程事件流连接失败"));
			shutdown();
		});
		if (signal !== undefined) {
			if (signal.aborted) throw new Error("已取消");
			signal.addEventListener("abort", shutdown, { once: true });
		}

		await new Promise((resolve, reject) => {
			socket.addEventListener("open", resolve, { once: true });
			socket.addEventListener("error", () => reject(new Error("无法建立远程事件流")), { once: true });
		});
		socket.send(JSON.stringify({ type: "open", streamId, endpoint, payload: { args } }));
		opened = true;
		for await (const item of channel) yield item;
	} finally {
		shutdown();
	}
}

/**
 * Text carried by one `session/follow` frame.
 *
 * Two shapes carry assistant output: a live `assistant-stream` frame, and a
 * snapshot's replay of the attempt already in flight. Reasoning deltas are
 * deliberately dropped — the local Session shows the remote's answer, not its
 * private thinking.
 *
 * @returns `{ index, text }`, or undefined for frames that carry no answer text.
 */
export function textDeltaOf(frame) {
	if (frame === undefined || frame === null) return undefined;
	if (frame.type === "assistant-stream") {
		const inner = frame.frame;
		if (inner?.type !== "chunk") return undefined;
		return chunkText(inner.chunk);
	}
	return undefined;
}

/** Text of one raw LLM chunk value. */
export function chunkText(chunk) {
	if (chunk?.type !== "text-delta") return undefined;
	if (typeof chunk.text !== "string" || chunk.text === "") return undefined;
	return { index: typeof chunk.index === "number" ? chunk.index : 0, text: chunk.text };
}
