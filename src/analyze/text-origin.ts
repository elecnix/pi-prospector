/**
 * Text origin: which parts of a turn's user text the person typed.
 *
 * Hosts file many things under the user role that the person never wrote. A
 * frustration word inside one of them says nothing about how the person feels,
 * so every piece of user text carries one of six labels:
 *
 *   - `typed`: what the person wrote. Anything no rule below claims.
 *   - `pasted`: a block the person pasted. A fenced code block, a
 *     `<pasted_content>` block, a `[Pasted text #N ...]` placeholder line, or a
 *     paragraph (lines between blank lines) of `PASTE_MIN_LINES` lines or more.
 *   - `quoted`: a line that starts with `>`, after optional indentation.
 *   - `agent`: words another agent wrote, here a `<teammate-message>` or
 *     `<cross-session-message>` block.
 *   - `notification`: text the harness injected, here the harness blocks such as
 *     `<task-notification>`, `<system-reminder>`, `<local-command-stdout>` or
 *     `<channel>`.
 *   - `fork-copy`: a turn a fork copied from its parent session.
 *
 * This module labels spans inside a message. The label of a whole message (a
 * child agent's prompt, a signed message, a pi entry, a compaction continuation,
 * a brief an orchestrator wrote) belongs to `message-origin.ts`, and
 * turn-frustration reads that node first. Only `fork-copy` is tested here before
 * the split, because it compares the turn with the parent session's turns, which
 * a message's own text cannot show. Otherwise the message is split into spans.
 * Harness blocks and fenced blocks are cut out first, and the text between them
 * is labelled line by line.
 *
 * The spans concatenate back to the message exactly, so a caller can count a
 * word in each span and know the counts cover the whole message.
 *
 * Two host flags never reach this module, and the reasons are recorded here.
 * Claude Code's `isMeta` lines are dropped by the parser, so they start no turn.
 * Claude Code's `isSidechain` lines appear only in child-agent transcripts,
 * which `message-origin.ts` labels `agent` through the session's parent link.
 *
 * Pure functions: no database, no state.
 */

import { Type, type Static } from "typebox";

export const TextOrigin = Type.Union([
	Type.Literal("typed"),
	Type.Literal("pasted"),
	Type.Literal("quoted"),
	Type.Literal("agent"),
	Type.Literal("notification"),
	Type.Literal("fork-copy"),
]);
export type TextOrigin = Static<typeof TextOrigin>;

/** Every label, in the order a tie between them is broken. */
export const TEXT_ORIGINS: readonly TextOrigin[] = ["typed", "pasted", "quoted", "agent", "notification", "fork-copy"];

/** A run of user text and its label. */
export const TextSpan = Type.Object({
	origin: TextOrigin,
	text: Type.String(),
});
export type TextSpan = Static<typeof TextSpan>;

/** What the labeller needs to know about the turn beyond its text. */
export const TurnOriginContext = Type.Object({
	/** The message is a copy a fork took from its parent (see {@link isForkCopy}). */
	forkCopy: Type.Boolean(),
});
export type TurnOriginContext = Static<typeof TurnOriginContext>;

/** A paragraph with this many lines or more is a paste. People rarely type eight lines without a blank one. */
export const PASTE_MIN_LINES = 8;

const NOTIFICATION_TAGS = new Set([
	"task-notification",
	"system-reminder",
	"local-command-stdout",
	"local-command-stderr",
	"local-command-caveat",
	"bash-stdout",
	"bash-stderr",
	"channel",
	"command-name",
	"command-message",
	"user-prompt-submit-hook",
]);
const AGENT_TAGS = new Set(["teammate-message", "cross-session-message"]);
const PASTE_TAGS = new Set(["pasted_content"]);

/**
 * A fenced block, or a balanced `<tag>…</tag>` pair. Claude Code repeats the
 * attributes on the closing tag of a paste (`</pasted_content id="4a2f">`), so a
 * closing tag may carry them.
 */
const BLOCK_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~|<([a-z][a-z0-9_-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1(?:\s[^>]*)?>/g;

const QUOTED_LINE_RE = /^[ \t]*>/;
const PASTE_PLACEHOLDER_RE = /^[ \t]*\[Pasted text #\d+/;

/** The label a block gets, or null when it is ordinary text (an HTML tag in prose, say). */
function blockOrigin(match: RegExpMatchArray): TextOrigin | null {
	const tag = match[1];
	if (tag === undefined) return "pasted";
	if (PASTE_TAGS.has(tag)) return "pasted";
	if (AGENT_TAGS.has(tag)) return "agent";
	if (NOTIFICATION_TAGS.has(tag)) return "notification";
	return null;
}

/** Label the text between blocks, line by line. */
function labelLines(text: string, out: TextSpan[]): void {
	const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		if (!line.trim()) {
			out.push({ origin: "typed", text: line });
			i++;
			continue;
		}
		let end = i;
		while (end < lines.length && lines[end]!.trim()) end++;
		const paragraph = lines.slice(i, end);
		if (paragraph.length >= PASTE_MIN_LINES) {
			out.push({ origin: "pasted", text: paragraph.join("") });
		} else {
			for (const l of paragraph) {
				const origin: TextOrigin = QUOTED_LINE_RE.test(l) ? "quoted" : PASTE_PLACEHOLDER_RE.test(l) ? "pasted" : "typed";
				out.push({ origin, text: l });
			}
		}
		i = end;
	}
}

/**
 * Merge neighbours with the same label, and give whitespace-only runs to the
 * span before them (or after them, at the start), so a blank line never shows up
 * as a span of its own.
 */
function merge(spans: TextSpan[]): TextSpan[] {
	const out: TextSpan[] = [];
	let pendingBlank = "";
	for (const span of spans) {
		if (!span.text) continue;
		if (!span.text.trim()) {
			const last = out[out.length - 1];
			if (last) last.text += span.text;
			else pendingBlank += span.text;
			continue;
		}
		const last = out[out.length - 1];
		if (last && last.origin === span.origin) {
			last.text += span.text;
		} else {
			out.push({ origin: span.origin, text: pendingBlank + span.text });
			pendingBlank = "";
		}
	}
	if (pendingBlank && out.length === 0) return [];
	return out;
}

/** Split a turn's user text into labelled spans. Returns no spans for blank text. */
export function labelUserText(text: string, ctx: TurnOriginContext): TextSpan[] {
	if (!text.trim()) return [];
	if (ctx.forkCopy) return [{ origin: "fork-copy", text }];

	const spans: TextSpan[] = [];
	let cursor = 0;
	for (const match of text.matchAll(BLOCK_RE)) {
		const origin = blockOrigin(match);
		if (origin === null) continue;
		const start = match.index;
		if (start > cursor) labelLines(text.slice(cursor, start), spans);
		spans.push({ origin, text: match[0] });
		cursor = start + match[0].length;
	}
	if (cursor < text.length) labelLines(text.slice(cursor), spans);
	return merge(spans);
}

/** A turn-starting message, as {@link isForkCopy} compares it. */
export const OriginMessage = Type.Object({
	text: Type.String(),
	timestamp: Type.Union([Type.String(), Type.Null()]),
});
export type OriginMessage = Static<typeof OriginMessage>;

/**
 * Whether a fork copied this message from its parent session.
 *
 * The parent must hold a turn with the same text, and one of two facts must
 * place the message before the fork: the parent's turn has the same timestamp
 * (a copy keeps it), or the message is older than the fork session itself.
 * Requiring one of them keeps a person who types the same words again after
 * the fork from losing them.
 *
 * A copy that keeps the parent's message id never reaches this test. The index
 * stores a message id once, so only one session holds that row and its words
 * count once.
 */
export function isForkCopy(
	message: OriginMessage,
	sessionStartedAt: string | null,
	parentTurns: readonly OriginMessage[],
): boolean {
	const text = message.text.trim();
	if (!text) return false;
	const same = parentTurns.filter((p) => p.text.trim() === text);
	if (same.length === 0) return false;
	if (message.timestamp !== null && same.some((p) => p.timestamp === message.timestamp)) return true;
	const at = message.timestamp === null ? NaN : Date.parse(message.timestamp);
	const start = sessionStartedAt ? Date.parse(sessionStartedAt) : NaN;
	return Number.isFinite(at) && Number.isFinite(start) && at < start;
}
