/**
 * Message helpers shared by the remote adapter.
 *
 * Kept dependency-free so the decisions below stay unit-testable outside the
 * dsh runtime (the adapter itself imports runtime packages).
 *
 * Two kinds of request reach the adapter:
 *   - a real conversation turn, whose newest message carries `source.kind ===
 *     'user'` — this is what the remote session must receive;
 *   - a runtime-generated request (session title, summaries, …), which must NOT
 *     be forwarded, or the remote conversation fills up with machine prompts.
 */

/** Sources that represent the person actually typing. */
const USER_SOURCES = new Set(["user"]);

/**
 * Newest user-authored text in a request.
 *
 * The loop appends its own runtime-context message AFTER the user's message and
 * rebuilds the whole conversation every step, so "the newest user message" is
 * not the same as "what the person said". Messages whose source is absent are
 * treated as user text (older projections omit it); messages whose source names
 * something else are skipped.
 *
 * @param messages - canonical message list (role + content blocks + source).
 * @returns joined text, or undefined when the request carries no user text.
 */
export function latestUserText(messages) {
	if (!Array.isArray(messages)) return undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "user") continue;
		const sourceKind = message?.source?.kind;
		if (typeof sourceKind === "string" && !USER_SOURCES.has(sourceKind)) continue;
		const text = textOf(message.content);
		if (text !== undefined) return text;
	}
	return undefined;
}

/** True when the request carries at least one person-authored message. */
export function carriesUserTurn(messages) {
	return latestUserText(messages) !== undefined;
}

/**
 * Best-effort session title derived from a title-generation request, so that
 * request never has to travel to the remote environment.
 *
 * The shipped title generator embeds a JSON array of the session's human
 * messages in its prompt; the first human text is a good enough title.
 *
 * @param text - the whole prompt sent by the title generator.
 * @returns a short title, or undefined when nothing usable was found.
 */
export function titleFromRequest(text) {
	if (typeof text !== "string") return undefined;
	const match = text.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
	if (match === null) return undefined;
	let decoded = match[1];
	try {
		decoded = JSON.parse(`"${match[1]}"`);
	} catch { /* keep the raw capture */ }
	const cleaned = String(decoded).replace(/\s+/g, " ").trim();
	if (cleaned === "") return undefined;
	const characters = [...cleaned];
	return characters.length <= 24 ? cleaned : `${characters.slice(0, 24).join("")}…`;
}

/** Join the text parts of one message content value. */
function textOf(content) {
	if (typeof content === "string") return content === "" ? undefined : content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
	return text === "" ? undefined : text;
}
