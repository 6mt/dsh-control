/**
 * Remote-environment model adapter.
 *
 * A local Session whose model route is `dsh-control/<environment>` behaves like
 * any other Session: history, rendering, archiving, cancel — all native. The
 * only thing that changes is where the model call goes: `stream()` forwards the
 * newest user message to the paired Session on the remote environment and
 * streams the remote reply back as this call's output.
 *
 * Contract (from @deepseek-ai/dsh-llm):
 *   - extend `LlmAdapter`, register with `ctx.llm.registerAdapter(routes, adapter)`
 *   - `stream(options)` is an async generator of chunks:
 *       { type: 'block-start', index, blockType }
 *       { type: 'text-delta',  index, text }
 *       { type: 'block-end',   index, block }
 *       { type: 'finish',      reason }        reason: { kind: 'stop' | 'max-tokens' | 'tool-calls' }
 *   - a terminal failure is expressed by THROWING: the runtime converts an
 *     adapter throw into the stream's terminal `error`/`aborted` finish chunk.
 */
import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import { latestUserText, titleFromRequest } from "./messages.js";
import { prepareRemoteChannel } from "./channel.js";

export { latestUserText };

/** Provider route this adapter owns. */
export const PROVIDER = "dsh-control";

export class RemoteEnvironmentAdapter extends LlmAdapter {
	/**
	 * @param options.listEnvironments - names of currently configured environments.
	 * @param options.resolveRemoteSession - (localSessionId, environment) => remote session id.
	 * @param options.connectionFor - environment name => connection with `call(method, args)`.
	 */
	constructor(options) {
		super();
		this.listEnvironments = options.listEnvironments;
		this.resolveRemoteSession = options.resolveRemoteSession;
		this.connectionFor = options.connectionFor;
		this.ensureChannel = options.ensureChannel;
		this.afterTurn = options.afterTurn;
		this.onRequest = options.onRequest;
		this.onStream = options.onStream;
	}

	providerInfo(provider) {
		return { id: provider, name: "远程 dsh 环境" };
	}

	/**
	 * One model per environment: the model id IS the environment name.
	 * Each entry must carry `provider` — the runtime rejects entries without it
	 * as INVALID_CATALOG, which drops the whole provider from model selection.
	 */
	async listModels(provider) {
		const names = await this.listEnvironments();
		return names.map((name) => ({ provider, id: name, name }));
	}

	async *stream(options) {
		const environment = String(options.model ?? "");
		const text = latestUserText(options.messages);
		// Keep a shape-only snapshot of the newest request: which messages arrive,
		// what they carry, and whether the runtime-context injection is
		// distinguishable from the user's own words.
		this.onRequest?.({
			at: Date.now(),
			environment,
			messages: (options.messages ?? []).map((message) => ({
				role: message?.role,
				sourceKind: message?.source?.kind ?? null,
				parts: (Array.isArray(message?.content) ? message.content : []).map((part) => part?.type),
				textLength: Array.isArray(message?.content)
					? message.content.reduce((total, part) => total + (typeof part?.text === "string" ? part.text.length : 0), 0)
					: typeof message?.content === "string" ? message.content.length : 0,
			})),
			forwarded: typeof text === "string" ? text.slice(0, 80) : null,
		});

		if (text === undefined) {
			// A runtime-generated request (session title, summaries, …). Answering it
			// here keeps machine prompts out of the remote conversation.
			const local = this.answerRuntimeRequest(options);
			if (local !== undefined) {
				yield { type: "text-delta", index: 0, text: local };
				yield { type: "finish", reason: { kind: "stop" } };
				return;
			}
			throw new LlmError("这一轮不是用户消息，已跳过（不转发给远端）", "EMPTY_RESPONSE");
		}

		// The tunnel is started lazily; a local dsh that just restarted still holds
		// remote-session bindings, so the first turn must ensure the channel itself
		// instead of relying on some other screen having done it.
		const prepared = await prepareRemoteChannel(environment, {
			ensureChannel: this.ensureChannel,
			connectionFor: this.connectionFor,
		});
		if (prepared.ok !== true) {
			throw new LlmError(prepared.error, "NO_ADAPTER");
		}
		const connection = prepared.connection;

		// Lazily pair a remote Session the first time this local one runs.
		const remoteSessionId = await this.resolveRemoteSession(options.sessionId, environment);
		const [{ runRemoteTurn }, { createChannel }] = await Promise.all([
			import("./remote-turn.js"),
			import("./mux.js"),
		]);

		// The remote turn runs while this generator yields: text reaches the local
		// Session as the remote produces it instead of after the whole turn.
		const channel = createChannel();
		let outcome;
		const startedAt = Date.now();
		const turn = runRemoteTurn(connection, remoteSessionId, text, {
			signal: options.signal,
			onDelta: (piece) => channel.push(piece),
		}).then(
			(result) => { outcome = result; channel.end(); },
			(error) => {
				outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
				channel.end();
			},
		);

		let emitted = "";
		let started = false;
		let firstDeltaAt;
		for await (const piece of channel) {
			if (!started) {
				started = true;
				firstDeltaAt = Date.now();
				yield { type: "block-start", index: 0, blockType: "text" };
			}
			emitted += piece;
			yield { type: "text-delta", index: 0, text: piece };
		}
		await turn;

		// Nothing streamed and the turn failed: report it as this call's failure.
		if (outcome?.ok === false && emitted === "") {
			throw new LlmError(outcome.error ?? "远端这一轮失败", "ADAPTER_FAILURE");
		}
		const finalText = outcome?.ok === true ? outcome.text : emitted;
		// Whatever streamed is a prefix of the authoritative text; send the rest
		// (a mismatch means the stream dropped early, and re-sending would duplicate).
		if (finalText !== emitted && finalText.startsWith(emitted)) {
			const tail = finalText.slice(emitted.length);
			if (!started) {
				started = true;
				yield { type: "block-start", index: 0, blockType: "text" };
			}
			emitted = finalText;
			yield { type: "text-delta", index: 0, text: tail };
		}
		if (emitted.trim() === "") {
			throw new LlmError("远端这一轮没有返回文本", "EMPTY_RESPONSE");
		}

		// The local title only exists after the first reply, so refresh the remote
		// Session's name now that it can be known.
		this.afterTurn?.(options.sessionId, environment);
		this.onStream?.({
			streamed: outcome?.streamed === true,
			startedAt,
			firstDeltaAt,
			finishedAt: Date.now(),
			characters: emitted.length,
		});
		yield { type: "block-end", index: 0, block: { type: "text", text: emitted } };
		yield { type: "finish", reason: { kind: "stop" } };
	}

	/**
	 * Answer a runtime-generated request locally.
	 * @returns the answer text, or undefined when this request has no local answer.
	 */
	answerRuntimeRequest(options) {
		const kinds = new Set((options.messages ?? []).map((message) => message?.source?.kind).filter(Boolean));
		if (kinds.has("dsh-session-title-llm")) {
			const prompt = allText(options.messages);
			return titleFromRequest(prompt);
		}
		return undefined;
	}
}

/** Concatenate every text part in a request, used for local answers. */
function allText(messages) {
	if (!Array.isArray(messages)) return "";
	return messages
		.flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
		.filter((part) => typeof part?.text === "string")
		.map((part) => part.text)
		.join("\n");
}
