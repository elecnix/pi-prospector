/**
 * Best-effort rebuild of a Claude Code transcript from the reduced projection the
 * index kept (#400). Used only for a session synced before raw capture existed;
 * a session with its original bytes is exported exactly instead.
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
	records: Array<Record<string, unknown>>;
	/** Counts of the inferences the rebuild made, by name. */
	notes: Record<string, number>;
}

/** What a rebuild cannot restore, for the sidecar beside the file. */
export const NOT_RESTORED: string[] = [
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
export function rebuildClaudeRecords(session: StoredSession, messages: StoredMessage[], relPath: string): RebuildResult {
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
 * with one newline, and keeps each result's text length. Slicing the string by
 * those lengths gives parts that join back to the identical string, which is what
 * makes the rebuilt record parse into the stored row. Lengths count UTF-16 code
 * units, as the parser's `String.length` did.
 */
function toolResultBlocks(m: StoredMessage, notes: Record<string, number>): Array<Record<string, unknown>> {
	const results = parseJson<StoredToolResult>(m.tool_results);
	const text = m.content_text ?? "";
	const lengths = results.map((t) => t.textLength ?? 0);
	const expected = lengths.reduce((a, b) => a + b, 0) + Math.max(0, lengths.filter((x) => x > 0).length - 1);
	const extra = text.length - expected;

	// Text that came before the results (a user text block in the same message).
	let lead = "";
	let pos = 0;
	if (extra > 0 && expected > 0 && text[extra - 1] === "\n") {
		lead = text.slice(0, extra - 1);
		pos = extra;
	} else if (extra > 0 && expected === 0) {
		lead = text;
		pos = text.length;
	}

	const blocks: Array<Record<string, unknown>> = [];
	if (lead) {
		blocks.push({ type: "text", text: lead });
		bump(notes, "tool_result_extra_text");
	}
	let first = true;
	for (const t of results) {
		const length = t.textLength ?? 0;
		let body = "";
		if (length > 0) {
			if (!first) pos += 1;
			body = text.slice(pos, pos + length);
			pos += length;
			first = false;
		}
		const block: Record<string, unknown> = { tool_use_id: t.toolCallId ?? "", type: "tool_result", content: body };
		if (t.isError) block["is_error"] = true;
		blocks.push(block);
	}
	if (pos < text.length) {
		const rest = (!first || pos > 0) && text[pos] === "\n" ? text.slice(pos + 1) : text.slice(pos);
		if (rest) {
			blocks.push({ type: "text", text: rest });
			bump(notes, "tool_result_extra_text");
		}
	}
	return blocks;
}

/** The records as the bytes of a transcript: one compact JSON object per line. */
export function serializeRecords(records: Array<Record<string, unknown>>): string {
	return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}
