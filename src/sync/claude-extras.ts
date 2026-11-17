/**
 * What a Claude Code record carries that the message columns do not (#400).
 *
 * The parser keeps the text, thinking, tool calls, tool results, ids, model and
 * four token counts of a user or assistant line. This module reads the rest:
 * the order and boundaries of the content blocks, the record fields the parser
 * drops, the usage fields beyond the four counts, and the original tool name
 * where its casing differs. Nothing a column already holds is copied.
 *
 * It is the one place that knows Claude Code's record shapes for this purpose.
 * The tables it fills (`message_extras`, `session_events`) are generic: another
 * source fills them with its own kinds and keys.
 *
 * A value whose JSON is longer than `MAX_VALUE_CHARS` (a base64 image, a large
 * attachment, an opaque signature, a request body) is replaced by a marker holding
 * its size and SHA-256. The export reports each marker as a piece it could not
 * restore.
 */
import * as crypto from "node:crypto";
import { denormalizeClaudeToolName, normalizeClaudeToolName } from "./parser.js";

/** A value whose JSON is longer than this is stored as a size and a hash. */
export const MAX_VALUE_CHARS = 256;

/** The key that marks an elided string. */
export const OMITTED_KEY = "$omitted";

export interface OmittedMarker {
	bytes: number;
	sha256: string;
}

type Json = Record<string, unknown>;

/** `value`, or a marker `{ "$omitted": { bytes, sha256 } }` when its JSON is over the limit. */
export function elide(value: unknown): unknown {
	if (value === null || typeof value !== "object") {
		if (typeof value !== "string" || value.length + 2 <= MAX_VALUE_CHARS) return value;
		return { [OMITTED_KEY]: { bytes: Buffer.byteLength(value), sha256: crypto.createHash("sha256").update(value).digest("hex") } };
	}
	const json = JSON.stringify(value);
	if (json.length <= MAX_VALUE_CHARS) return value;
	return { [OMITTED_KEY]: { bytes: Buffer.byteLength(json), sha256: crypto.createHash("sha256").update(json).digest("hex") } };
}

/** `obj` with each top-level value elided on its own, so one heavy field does not hide the others. */
export function elideFields(obj: Json): Json {
	const out: Json = {};
	for (const [k, v] of Object.entries(obj)) out[k] = elide(v);
	return out;
}

/** True for a marker `elide` wrote. */
export function isOmitted(value: unknown): value is { [OMITTED_KEY]: OmittedMarker } {
	return value !== null && typeof value === "object" && !Array.isArray(value) && OMITTED_KEY in (value as Json);
}

/** One content block, as the extras describe it. */
export interface BlockShape {
	/** The block's `type`. */
	t: string;
	/** Length of the text the block contributed to a joined column, in UTF-16 code units. */
	n?: number;
	/** The original tool name, when `denormalizeClaudeToolName` of the stored name is not it. */
	nm?: string;
	/** A tool result's content: "s" for a string, "z" when absent, else its items. */
	ci?: "s" | "z" | BlockShape[];
	/** The block's other fields. */
	x?: Json;
}

export interface MessageExtras {
	/** Set when the record's content was a plain string. */
	cs?: 1;
	/** The content blocks in order. Absent when the content was a string. */
	b?: BlockShape[];
	/**
	 * Fields no column holds, flattened: a record field under its own name, a
	 * `message` field as `message.<name>`, a usage field beyond the four counts as
	 * `usage.<name>`. A field that repeats from record to record (a sticky key) is
	 * written only when its value changes; any other field is written every time.
	 */
	f?: Json;
	/** Sticky fields the previous record of the same role had and this one lacks. */
	del?: string[];
	/** Set on the first record of a read: the sticky keys, and no earlier record's fields carry forward. */
	sk?: string[];
}

/** Top-level keys a column holds, or that carry no information of their own. */
const COLUMN_KEYS = new Set(["type", "uuid", "parentUuid", "timestamp", "message"]);

const USAGE_COUNT_KEYS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];

function rest(block: Json, drop: string[]): Json | undefined {
	const out: Json = {};
	for (const [k, v] of Object.entries(block)) if (!drop.includes(k)) out[k] = elide(v);
	return Object.keys(out).length > 0 ? out : undefined;
}

function shape(t: string, extra: Partial<BlockShape>): BlockShape {
	const b: BlockShape = { t };
	for (const [k, v] of Object.entries(extra)) if (v !== undefined) (b as unknown as Json)[k] = v;
	return b;
}

function textLike(block: Json, key: "text" | "thinking"): BlockShape {
	return shape(block["type"] as string, { n: (block[key] as string).length, x: rest(block, ["type", key]) });
}

function resultItems(content: unknown): "s" | "z" | BlockShape[] {
	if (typeof content === "string") return "s";
	if (!Array.isArray(content)) return "z";
	return content.map((item): BlockShape => {
		if (item && typeof item === "object" && (item as Json)["type"] === "text" && typeof (item as Json)["text"] === "string") return textLike(item as Json, "text");
		if (item && typeof item === "object") return shape(String((item as Json)["type"] ?? "?"), { x: rest(item as Json, ["type"]) });
		return shape("?", { x: { value: elide(item) } });
	});
}

function blockShape(block: unknown, assistant: boolean): BlockShape {
	if (!block || typeof block !== "object") return shape("?", { x: { value: elide(block) } });
	const b = block as Json;
	const type = b["type"];
	if (type === "text" && typeof b["text"] === "string") return textLike(b, "text");
	if (assistant && type === "thinking" && typeof b["thinking"] === "string") return textLike(b, "thinking");
	if (assistant && type === "tool_use") {
		const stored = normalizeClaudeToolName(String(b["name"] ?? ""));
		const original = String(b["name"] ?? "");
		return shape("tool_use", { nm: denormalizeClaudeToolName(stored) === original ? undefined : original, x: rest(b, ["type", "id", "name", "input"]) });
	}
	if (!assistant && type === "tool_result") {
		const ci = resultItems(b["content"]);
		// is_error is a column when true; a false or odd value is kept as a field.
		return shape("tool_result", { ci, x: rest(b, b["is_error"] === true ? ["type", "tool_use_id", "content", "is_error"] : ["type", "tool_use_id", "content"]) });
	}
	return shape(String(type ?? "?"), { x: rest(b, ["type"]) });
}

/** What carries forward from record to record within one read. */
export interface ExtrasState {
	/** Keys whose value usually equals the previous record's: stored when it changes only. */
	sticky: Set<string>;
	/** The sticky fields as of the previous record of each role, or null before the first. */
	last: { assistant: Json | null; user: Json | null };
	started: boolean;
}

export function newExtrasState(sticky: Set<string>): ExtrasState {
	return { sticky, last: { assistant: null, user: null }, started: false };
}

/** The fields of a record that no column holds, flattened and elided. */
export function flatFields(obj: Json, hasUsageColumn: boolean): Json {
	const assistant = obj["type"] === "assistant";
	const msg = (obj["message"] ?? {}) as Json;
	const flat: Json = {};
	for (const [k, v] of Object.entries(obj)) {
		if (COLUMN_KEYS.has(k)) continue;
		if (k === "isApiErrorMessage" && v === true) continue;
		flat[k] = elide(v);
	}
	const handled = new Set<string>(["content", "usage"]);
	if (assistant) {
		if (typeof msg["id"] === "string") handled.add("id");
		if (typeof msg["model"] === "string" && msg["model"] !== "") handled.add("model");
		if (typeof msg["stop_reason"] === "string" && msg["stop_reason"] !== "" && obj["isApiErrorMessage"] !== true) handled.add("stop_reason");
	}
	if (msg["role"] === (assistant ? "assistant" : "user")) handled.add("role");
	for (const [k, v] of Object.entries(msg)) if (!handled.has(k)) flat[`message.${k}`] = elide(v);
	const content = msg["content"];
	if (content !== undefined && typeof content !== "string" && !Array.isArray(content)) flat["message.content"] = elide(content);
	const usage = msg["usage"];
	if (usage && typeof usage === "object" && !Array.isArray(usage)) {
		for (const [k, v] of Object.entries(usage as Json)) if (!hasUsageColumn || !USAGE_COUNT_KEYS.includes(k)) flat[`usage.${k}`] = elide(v);
	} else if (usage !== undefined) {
		flat["usage"] = elide(usage);
	}
	return flat;
}

/** Count, per role and key, how often a value repeats the last one seen: the data a sticky set comes from. */
export interface StickyCounts {
	seen: Map<string, number>;
	same: Map<string, number>;
	last: { assistant: Map<string, string>; user: Map<string, string> };
}

export function newStickyCounts(): StickyCounts {
	return { seen: new Map(), same: new Map(), last: { assistant: new Map(), user: new Map() } };
}

export function observeFields(c: StickyCounts, role: "assistant" | "user", flat: Json): void {
	const last = c.last[role];
	for (const [k, v] of Object.entries(flat)) {
		const json = JSON.stringify(v);
		c.seen.set(k, (c.seen.get(k) ?? 0) + 1);
		if (last.get(k) === json) c.same.set(k, (c.same.get(k) ?? 0) + 1);
		last.set(k, json);
	}
}

/** Keys seen at least three times whose value repeats the last one at least half the time. */
export function stickyKeys(c: StickyCounts): Set<string> {
	const out = new Set<string>();
	for (const [k, n] of c.seen) if (n >= 3 && (c.same.get(k) ?? 0) * 2 >= n) out.add(k);
	return out;
}

/**
 * The extras of one parsed message record, advancing `state`.
 */
export function claudeMessageExtras(obj: Json, state: ExtrasState, hasUsageColumn: boolean): MessageExtras {
	const assistant = obj["type"] === "assistant";
	const role = assistant ? "assistant" : "user";
	const msg = (obj["message"] ?? {}) as Json;
	const extras: MessageExtras = {};
	if (!state.started) {
		extras.sk = [...state.sticky];
		state.started = true;
	}

	const flat = flatFields(obj, hasUsageColumn);
	const last = state.last[role];
	const f: Json = {};
	for (const [k, v] of Object.entries(flat)) {
		if (!state.sticky.has(k) || last === null || last[k] === undefined || JSON.stringify(last[k]) !== JSON.stringify(v)) f[k] = v;
	}
	const del = last === null ? [] : Object.keys(last).filter((k) => !(k in flat));
	state.last[role] = { ...(last ?? {}) };
	const cur = state.last[role]!;
	for (const k of del) delete cur[k];
	for (const [k, v] of Object.entries(flat)) if (state.sticky.has(k)) cur[k] = v;
	if (Object.keys(f).length > 0) extras.f = f;
	if (del.length > 0) extras.del = del;

	const content = msg["content"];
	if (typeof content === "string") extras.cs = 1;
	else if (Array.isArray(content)) extras.b = content.map((c) => blockShape(c, assistant));
	return extras;
}

/** The `kind` and payload of a source line that is not a message. */
export function claudeEventOf(obj: unknown, raw: string): { kind: string; payload: unknown } {
	if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
		const type = (obj as Json)["type"];
		return { kind: typeof type === "string" && type !== "" ? type : "unknown", payload: elideFields(obj as Json) };
	}
	return { kind: "unparsed", payload: { text: elide(raw) } };
}
