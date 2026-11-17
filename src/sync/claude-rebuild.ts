/**
 * Best-effort rebuild of a Claude Code transcript from the index (#400).
 *
 * A message synced with its extras (`message_extras`) is rebuilt from its columns
 * plus those extras: the extras say where each block begins and ends, so the text
 * columns split back into the original blocks. A message synced before the extras
 * existed has only its columns, and is rebuilt from them with the inferences
 * below. Records that are not messages come back from `session_events`.
 *
 * The rebuild writes records the parser reads back into the same rows. That is
 * what makes re-importing one harmless: messages insert with `INSERT OR IGNORE`
 * on their id, so an existing row cannot change, and the joined-text conventions
 * below keep even a fresh parse of the file equal to the stored row.
 *
 * Every rebuilt record carries `restoredFrom`, so a reader can tell a rebuilt
 * record from an original one.
 */
import { denormalizeClaudeToolName } from "./parser.js";
import { LEFT_OUT_EVENT_KINDS, SKIPPED_FIELDS, STORED_EVENT_KINDS, isOmitted, OMITTED_KEY, type BlockShape, type MessageExtras } from "./claude-extras.js";

export const RESTORED_FROM = "pi-prospector";

/** One stored message, as read from the `messages` table in insertion order. */
export interface StoredMessage {
	id: string;
	parent_id: string | null;
	timestamp: string | null;
	role: string;
	content_text: string | null;
	content_thinking: string | null;
	tool_calls: string | null;
	tool_results: string | null;
	usage: string | null;
	model: string | null;
	provider_message_id: string | null;
	stop_reason: string | null;
	error_message: string | null;
	/** The message's `message_extras` row, parsed, or null for a message synced before extras. */
	extras?: MessageExtras | null;
	/** Its line in the source file, when extras recorded it. */
	line?: number | null;
}

/** One stored `session_events` row, payload parsed. */
export interface StoredEvent {
	line: number;
	kind: string;
	ref: string;
	payload: unknown;
}

/** The session columns a rebuild reads. */
export interface StoredSession {
	id: string;
	cwd: string;
	name: string | null;
}

interface StoredToolCall {
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

interface StoredToolResult {
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	textLength?: number;
}

export interface RebuildResult {
	records: Array<Record<string, unknown> | string>;
	/** Counts of the inferences the rebuild made, by name. */
	notes: Record<string, number>;
	/** Small files the host wrote beside the session: where they go and what they held. */
	sidecars?: Array<{ ref: string; payload: unknown }>;
}

/** What a message synced before the extras existed cannot give back. */
export const PROJECTION_LOSSES: string[] = [
	"every record that is not a user or assistant message: system, attachment, queue-operation, last-prompt, pr-link, file-history-snapshot, file-history-delta, mode, permission-mode, cost-state, session-owner, tools-used, api-request",
	"user lines flagged isMeta (slash-command expansions, caveats, command output)",
	"thinking signatures and redacted_thinking blocks",
	"images and every other non-text block in a user message or tool result",
	"per-record fields the sync never read: gitBranch, version, entrypoint, userType, promptId, promptSource, origin, permissionMode, slug, requestId, toolUseResult, sourceToolAssistantUUID",
	"the order of content blocks inside one record (thinking, then text, then tool calls)",
	"the block structure of a tool result (rebuilt as one string)",
	"usage beyond four token counts: cache tiers, service tier, server tool use",
	"the original casing of a tool Claude Code named in lower case",
	"titles other than the last one the index kept",
];

/** What no session gives back, extras or not. */
export const ALWAYS_LOST: string[] = [
	`records of the kinds the sync leaves out: ${LEFT_OUT_EVENT_KINDS.join(", ")}, and any kind not in the stored list (${STORED_EVENT_KINDS.join(", ")})`,
	`record, message and usage fields the sync leaves out: ${SKIPPED_FIELDS.join(", ")}`,
	"blank lines, key order and whitespace inside a record",
	"a usage count the record left out: the rebuild writes all four token counts",
	"a string the sync stored as a size and hash only (an image, a large attachment, an opaque signature); each is marked $omitted in the file",
	"a user or assistant record whose message id another session already owns (the index stores each message once)",
];

function bump(notes: Record<string, number>, key: string): void {
	notes[key] = (notes[key] ?? 0) + 1;
}

function parseJson<T>(raw: string | null): T[] {
	if (!raw) return [];
	const v: unknown = JSON.parse(raw);
	return Array.isArray(v) ? (v as T[]) : [];
}

/** The id of the session file's parent session, for a child agent's transcript. */
function parentSessionOf(relPath: string): string | null {
	const parts = relPath.split("/");
	for (let i = parts.length - 2; i >= 0; i--) {
		if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[i] ?? "")) return parts[i] ?? null;
	}
	return null;
}

/**
 * Rebuild the records of one session. `relPath` is the transcript's path under
 * the sessions root and decides whether it is a child agent's file, whose records
 * carry the parent's session id and the agent id.
 */
function rebuildFromProjection(session: StoredSession, messages: StoredMessage[], relPath: string): RebuildResult {
	const notes: Record<string, number> = {};
	const base = relPath.split("/").pop() ?? "";
	const isAgent = base.startsWith("agent-");
	const parent = isAgent ? parentSessionOf(relPath) : null;
	const fileSessionId = parent ?? session.id;
	const agentId = isAgent ? base.slice("agent-".length).replace(/\.jsonl$/i, "") : null;

	// A call stored without its id (a row synced before ids were kept) takes the id of the
	// next later result of the same tool name: results follow their calls, in call order.
	const pending = new Map<string, Array<{ index: number; id: string }>>();
	messages.forEach((m, index) => {
		for (const t of parseJson<StoredToolResult>(m.tool_results)) {
			const list = pending.get(t.toolName ?? "") ?? [];
			list.push({ index, id: t.toolCallId ?? "" });
			pending.set(t.toolName ?? "", list);
		}
	});

	const records: Array<Record<string, unknown>> = [];
	if (session.name) {
		// First, so even a parser that stopped scanning early still finds it.
		records.push({ type: "ai-title", aiTitle: session.name, sessionId: fileSessionId, restoredFrom: RESTORED_FROM });
	}

	messages.forEach((m, index) => {
		const r: Record<string, unknown> = { parentUuid: m.parent_id, isSidechain: isAgent };
		if (session.cwd.startsWith("/")) r["cwd"] = session.cwd;
		r["sessionId"] = fileSessionId;
		if (agentId) r["agentId"] = agentId;
		r["uuid"] = m.id;
		if (m.timestamp) r["timestamp"] = m.timestamp;

		if (m.role === "assistant") {
			const blocks: Array<Record<string, unknown>> = [];
			if (m.content_thinking !== null) blocks.push({ type: "thinking", thinking: m.content_thinking });
			if (m.content_text !== null) blocks.push({ type: "text", text: m.content_text });
			const calls = parseJson<StoredToolCall>(m.tool_calls);
			for (const c of calls) {
				let id = c.id ?? "";
				if (!id) {
					const queue = pending.get(c.name ?? "");
					while (queue && queue.length > 0 && (queue[0]?.index ?? 0) <= index) queue.shift();
					const next = queue?.shift();
					if (next) {
						id = next.id;
						bump(notes, "tool_use_id_inferred");
					}
				}
				const block: Record<string, unknown> = { type: "tool_use" };
				if (id) block["id"] = id;
				block["name"] = denormalizeClaudeToolName(c.name ?? "");
				block["input"] = c.arguments ?? {};
				blocks.push(block);
			}
			if (blocks.length > 1) bump(notes, "block_order_inferred");
			const msg: Record<string, unknown> = {};
			if (m.provider_message_id) msg["id"] = m.provider_message_id;
			msg["type"] = "message";
			msg["role"] = "assistant";
			if (m.model) msg["model"] = m.model;
			msg["content"] = blocks;
			if (m.stop_reason && m.stop_reason !== "error") msg["stop_reason"] = m.stop_reason;
			if (m.usage) {
				const u = JSON.parse(m.usage) as Record<string, number>;
				msg["usage"] = {
					input_tokens: u["input"] ?? 0,
					output_tokens: u["output"] ?? 0,
					cache_read_input_tokens: u["cacheRead"] ?? 0,
					cache_creation_input_tokens: u["cacheWrite"] ?? 0,
				};
			}
			r["message"] = msg;
			r["type"] = "assistant";
			if (m.stop_reason === "error") r["isApiErrorMessage"] = true;
		} else if (m.role === "toolResult") {
			r["message"] = { role: "user", content: toolResultBlocks(m, notes) };
			r["type"] = "user";
			bump(notes, "tool_result_records");
		} else {
			r["message"] = { role: "user", content: m.content_text ?? [] };
			r["type"] = "user";
		}
		r["restoredFrom"] = RESTORED_FROM;
		records.push(r);
	});
	return { records, notes };
}

/**
 * Split the joined text of a tool-result message back into its blocks.
 *
 * The parser joins every text part, user text blocks and tool-result texts alike,
 * with one newline, and keeps each result's text length. The rebuild searches for
 * a layout in which the results sit at their stored lengths, every cut falls on a
 * newline, and the text blocks fill what is left, so the parser joins the record
 * back into the identical string. Text may come before, between and after the
 * results, and a text block may be empty, because the parser keeps an empty text
 * part but adds none for an empty result. When the same string splits more than one way the earliest layout wins,
 * so which text belongs to which block is an inference, counted in the notes.
 * Lengths count UTF-16 code units, as the parser's `String.length` did.
 */
function toolResultBlocks(m: StoredMessage, notes: Record<string, number>): Array<Record<string, unknown>> {
	const results = parseJson<StoredToolResult>(m.tool_results);
	const text = m.content_text;
	const sized = results.map((t, i) => ({ i, length: t.textLength ?? 0 })).filter((r) => r.length > 0);
	const before = new Map<number, string>();
	let tail: string | null = null;

	const place = (k: number, pos: number): boolean => {
		const body = text ?? "";
		if (k === sized.length) {
			if (pos >= body.length + 1) return true;
			tail = body.slice(pos);
			return true;
		}
		const { i, length } = sized[k]!;
		const fits = (start: number): boolean => start + length <= body.length && (start + length === body.length || body[start + length] === "\n");
		const attempt = (start: number, lead: string | null): boolean => {
			if (!fits(start)) return false;
			if (lead !== null) before.set(i, lead);
			if (place(k + 1, start + length + 1)) return true;
			before.delete(i);
			return false;
		};
		if (attempt(pos, null)) return true;
		for (let e = body.indexOf("\n", pos); e !== -1; e = body.indexOf("\n", e + 1)) {
			if (attempt(e + 1, body.slice(pos, e))) return true;
		}
		return false;
	};

	const blocks: Array<Record<string, unknown>> = [];
	const resultBlock = (t: StoredToolResult, body: string): Record<string, unknown> => {
		const block: Record<string, unknown> = { tool_use_id: t.toolCallId ?? "", type: "tool_result", content: body };
		if (t.isError) block["is_error"] = true;
		return block;
	};

	if (sized.length === 0) {
		if (text !== null) {
			blocks.push({ type: "text", text });
			bump(notes, "tool_result_extra_text");
		}
		for (const t of results) blocks.push(resultBlock(t, ""));
		return blocks;
	}

	if (text !== null && place(0, 0)) {
		const starts = new Map<number, number>();
		// Recompute each sized result's start from the pieces the search kept.
		let pos = 0;
		for (const { i, length } of sized) {
			const lead = before.get(i);
			if (lead !== undefined) pos += lead.length + 1;
			starts.set(i, pos);
			pos += length + 1;
		}
		results.forEach((t, i) => {
			const lead = before.get(i);
			if (lead !== undefined) {
				blocks.push({ type: "text", text: lead });
				bump(notes, "tool_result_extra_text");
			}
			const start = starts.get(i);
			blocks.push(resultBlock(t, start === undefined ? "" : text.slice(start, start + (t.textLength ?? 0))));
		});
		if (tail !== null) {
			blocks.push({ type: "text", text: tail });
			bump(notes, "tool_result_extra_text");
		}
		return blocks;
	}

	// No layout puts every cut on a newline: keep each result at its stored length, taken
	// from the text in order, and say the record is not an exact rebuild.
	bump(notes, "tool_result_layout_unrecoverable");
	let pos = 0;
	for (const t of results) {
		const length = t.textLength ?? 0;
		blocks.push(resultBlock(t, (text ?? "").slice(pos, pos + length)));
		pos += length + (length > 0 ? 1 : 0);
	}
	return blocks;
}

/** The records as the bytes of a transcript: one compact JSON object per line. */
export function serializeRecords(records: Array<Record<string, unknown> | string>): string {
	return records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";
}


// ─── Rebuild with extras ───

type Rec = Record<string, unknown>;

/**
 * Split a joined text column into its parts by their lengths, or null when the
 * lengths do not add up to the text (the extras and the column disagree).
 */
function splitParts(text: string | null, lengths: number[]): string[] | null {
	if (lengths.length === 0) return text === null || text === "" ? [] : null;
	if (text === null) return null;
	const total = lengths.reduce((a, b) => a + b, 0) + lengths.length - 1;
	if (total !== text.length) return null;
	const parts: string[] = [];
	let pos = 0;
	for (const n of lengths) {
		parts.push(text.slice(pos, pos + n));
		pos += n + 1;
	}
	return parts;
}

function withExtra(block: Rec, x: Rec | undefined): Rec {
	return x ? { ...block, ...x } : block;
}

function assistantContent(m: StoredMessage, shapes: BlockShape[]): Rec[] | null {
	const textParts = splitParts(m.content_text, shapes.filter((b) => b.t === "text").map((b) => b.n ?? 0));
	const thinkParts = splitParts(m.content_thinking, shapes.filter((b) => b.t === "thinking").map((b) => b.n ?? 0));
	const calls = parseJson<StoredToolCall>(m.tool_calls);
	if (!textParts || !thinkParts || calls.length !== shapes.filter((b) => b.t === "tool_use").length) return null;
	let ti = 0;
	let hi = 0;
	let ci = 0;
	return shapes.map((b): Rec => {
		if (b.t === "text") return withExtra({ type: "text", text: textParts[ti++] }, b.x);
		if (b.t === "thinking") return withExtra({ type: "thinking", thinking: thinkParts[hi++] }, b.x);
		if (b.t === "tool_use") {
			const c = calls[ci++]!;
			const block: Rec = { type: "tool_use" };
			if (c.id) block["id"] = c.id;
			block["name"] = b.nm ?? denormalizeClaudeToolName(c.name ?? "");
			block["input"] = c.arguments ?? {};
			return withExtra(block, b.x);
		}
		return withExtra({ type: b.t }, b.x);
	});
}

function userContent(m: StoredMessage, shapes: BlockShape[]): Rec[] | null {
	const results = parseJson<StoredToolResult>(m.tool_results);
	if (results.length !== shapes.filter((b) => b.t === "tool_result").length) return null;
	// The joined text holds each text block and each non-empty tool result, in block order.
	const lengths: number[] = [];
	let ri = 0;
	for (const b of shapes) {
		if (b.t === "text") lengths.push(b.n ?? 0);
		else if (b.t === "tool_result") {
			const n = results[ri++]?.textLength ?? 0;
			if (n > 0) lengths.push(n);
		}
	}
	const parts = splitParts(m.content_text, lengths);
	if (!parts) return null;
	let pi = 0;
	ri = 0;
	const out: Rec[] = [];
	for (const b of shapes) {
		if (b.t === "text") {
			out.push(withExtra({ type: "text", text: parts[pi++] }, b.x));
		} else if (b.t === "tool_result") {
			const r = results[ri++]!;
			const body = (r.textLength ?? 0) > 0 ? parts[pi++]! : "";
			const block: Rec = { type: "tool_result", tool_use_id: r.toolCallId ?? "" };
			if (b.ci === "s") block["content"] = body;
			else if (Array.isArray(b.ci)) {
				const inner = splitParts(body, b.ci.filter((i) => i.t === "text").map((i) => i.n ?? 0));
				if (!inner) return null;
				let ii = 0;
				block["content"] = b.ci.map((i): Rec => (i.t === "text" ? withExtra({ type: "text", text: inner[ii++] }, i.x) : withExtra({ type: i.t }, i.x)));
			}
			if (r.isError) block["is_error"] = true;
			out.push(withExtra(block, b.x));
		} else {
			out.push(withExtra({ type: b.t }, b.x));
		}
	}
	return out;
}

/** One message rebuilt from its columns and extras, or null when they disagree. */
function recordFromExtras(m: StoredMessage, x: MessageExtras, flat: Rec): Rec | null {
	const assistant = m.role === "assistant";
	let content: unknown;
	if (x.cs) content = m.content_text ?? "";
	else if (x.b) {
		const blocks = assistant ? assistantContent(m, x.b) : userContent(m, x.b);
		if (!blocks) return null;
		content = blocks;
	}
	// Split the flattened fields back into record, message and usage fields.
	const fields: Rec = {};
	const msg: Rec = {};
	const usageExtras: Rec = {};
	let usageValue: unknown;
	for (const [k, v] of Object.entries(flat)) {
		if (k.startsWith("message.")) msg[k.slice("message.".length)] = v;
		else if (k.startsWith("usage.")) usageExtras[k.slice("usage.".length)] = v;
		else if (k === "usage") usageValue = v;
		else fields[k] = v;
	}
	if (assistant) {
		if (m.provider_message_id) msg["id"] = m.provider_message_id;
		if (m.model) msg["model"] = m.model;
		if (m.stop_reason && m.stop_reason !== "error") msg["stop_reason"] = m.stop_reason;
	}
	if (!("role" in msg)) msg["role"] = assistant ? "assistant" : "user";
	if (content !== undefined) msg["content"] = content;
	if (m.usage) {
		const u = JSON.parse(m.usage) as Record<string, number>;
		msg["usage"] = { input_tokens: u["input"] ?? 0, output_tokens: u["output"] ?? 0, cache_read_input_tokens: u["cacheRead"] ?? 0, cache_creation_input_tokens: u["cacheWrite"] ?? 0, ...usageExtras };
	} else if (usageValue !== undefined) msg["usage"] = usageValue;
	else if (Object.keys(usageExtras).length > 0) msg["usage"] = usageExtras;
	const r: Rec = { ...fields, parentUuid: m.parent_id, uuid: m.id, type: assistant ? "assistant" : "user" };
	if (m.timestamp) r["timestamp"] = m.timestamp;
	r["message"] = msg;
	if (assistant && m.stop_reason === "error") r["isApiErrorMessage"] = true;
	r["restoredFrom"] = RESTORED_FROM;
	return r;
}

/** Count and total the strings the sync stored as a size and hash only. */
function countOmitted(value: unknown, tally: { strings: number; bytes: number }): void {
	if (Array.isArray(value)) value.forEach((v) => countOmitted(v, tally));
	else if (value !== null && typeof value === "object") {
		if (isOmitted(value)) {
			tally.strings++;
			tally.bytes += (value[OMITTED_KEY] as { bytes: number }).bytes;
		} else for (const v of Object.values(value)) countOmitted(v, tally);
	}
}

/**
 * Rebuild the lines of one session. `relPath` is the transcript's path under the
 * sessions root; `events` are the session's non-message records in line order.
 */
export function rebuildClaudeRecords(session: StoredSession, messages: StoredMessage[], relPath: string, events: StoredEvent[] = []): RebuildResult {
	const legacy = rebuildFromProjection(session, messages, relPath);
	const notes = legacy.notes;
	const offset = legacy.records.length - messages.length; // 1 when the projection added a title record
	const hasEvents = events.length > 0;
	const lines: Array<Rec | string> = [];
	const tally = { strings: 0, bytes: 0 };
	const sidecars: Array<{ ref: string; payload: unknown }> = [];
	const pending = events.filter((e) => e.line >= 0);
	for (const e of events) if (e.line < 0) sidecars.push({ ref: e.ref, payload: e.payload });
	let next = 0;
	let sticky = new Set<string>();
	const carried: { assistant: Rec; user: Rec } = { assistant: {}, user: {} };

	const flush = (before: number): void => {
		while (next < pending.length && pending[next]!.line < before) {
			const e = pending[next++]!;
			countOmitted(e.payload, tally);
			bump(notes, `event:${e.kind}`);
			if (e.kind === "unparsed") {
				const text = (e.payload as { text?: unknown }).text;
				if (typeof text === "string") lines.push(text);
				else bump(notes, "unparsed_line_omitted");
			} else if (e.payload !== null && typeof e.payload === "object") {
				lines.push({ ...(e.payload as Rec), restoredFrom: RESTORED_FROM });
			}
		}
	};

	// A projection title record is dropped when real events exist: the title is one of them.
	if (offset > 0 && !hasEvents) lines.push(legacy.records[0]!);
	let withExtras = 0;
	messages.forEach((m, i) => {
		const x = m.extras ?? null;
		let rec: Rec | null = null;
		if (x) {
			if (x.sk) {
				sticky = new Set(x.sk);
				carried.assistant = {};
				carried.user = {};
			}
			const state = m.role === "assistant" ? carried.assistant : carried.user;
			for (const k of x.del ?? []) delete state[k];
			for (const [k, v] of Object.entries(x.f ?? {})) if (sticky.has(k)) state[k] = v;
			if (m.line !== null && m.line !== undefined) flush(m.line);
			rec = recordFromExtras(m, x, { ...state, ...(x.f ?? {}) });
			if (rec) withExtras++;
			else bump(notes, "extras_disagree_with_columns");
		}
		if (!rec) {
			rec = legacy.records[i + offset] as Rec;
			bump(notes, "message_from_projection");
		}
		countOmitted(rec, tally);
		lines.push(rec);
	});
	flush(Number.MAX_SAFE_INTEGER);
	notes["messages_with_extras"] = withExtras;
	notes["omitted_strings"] = tally.strings;
	notes["omitted_bytes"] = tally.bytes;
	return { records: lines, notes, sidecars };
}
