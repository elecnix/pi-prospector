/**
 * JSONL line parser for Pi and Claude session files.
 */
import type { SessionHeader, MessageRole, ClaudeSessionMeta, SessionSource, UsageInfo } from "../types.js";

export interface ParsedSession {
	kind: "session";
	header: SessionHeader;
}

export interface UsageData {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

export interface ParsedMessage {
	kind: "message";
	entry: {
		id: string;
		parentId: string | null;
		timestamp: string | null;
		role: MessageRole;
		text: string | null;
		thinking: string | null;
		tool_calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> | null;
		tool_results: Array<{ toolCallId: string; toolName: string; isError: boolean; textLength: number }> | null;
		usage: UsageData | null;
		model: string | null;
		costUsd: number | null;
		/**
		 * The provider's id for the response this line belongs to. Claude Code
		 * splits one assistant response across a line per content block, each
		 * repeating the same `usage`, so this is the only key that identifies a
		 * single billed API call. Null when the transcript records none.
		 */
		providerMessageId: string | null;
		/**
		 * The host's recorded stop reason for an assistant generation
		 * (`toolUse`, `stop`, `error`, `length`, `aborted`, …), or null when the
		 * transcript recorded none. `error` is the marker of a **turn failure**:
		 * the generation was billed and produced nothing usable.
		 */
		stopReason: string | null;
		/**
		 * The host's recorded error text for a failed assistant generation, or
		 * null. It is the only record of *why* a turn failed — without it a turn
		 * failure is indistinguishable from a short reply, so no analyzer can tell
		 * a rate limit from a malformed tool call.
		 */
		errorMessage: string | null;
	};
}

export type ParsedLine = ParsedSession | ParsedMessage;

export function parseLine(line: string, source?: SessionSource, toolNamesById?: Map<string, string>): ParsedLine | null {
	if (source === "claude") return parseClaudeLine(line, toolNamesById);
	return parsePiLine(line);
}

function parsePiLine(line: string): ParsedLine | null {
	if (!line.trim()) return null;

	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(line);
	} catch {
		return null;
	}

	if (typeof obj !== "object" || obj === null) return null;

	const type = obj.type as string | undefined;

	// Session header
	if (type === "session") {
		return {
			kind: "session",
			header: {
				id: String(obj.id ?? ""),
				version: (obj.version as number) ?? 3,
				timestamp: obj.timestamp as string | undefined,
				cwd: obj.cwd as string | undefined,
				parentSession: obj.parentSession as string | undefined,
			},
		};
	}

	// Message entry
	if (type === "message") {
		const id = String(obj.id ?? "");
		const parentId = (obj.parentId as string) ?? null;
		const timestamp = (obj.timestamp as string) ?? null;
		const msg = obj.message as Record<string, unknown> | undefined;
		if (!msg) return null;

		const role = (msg.role as string) ?? "unknown";
		const content = msg.content;

		let text: string | null = null;
		let thinking: string | null = null;
		let tool_calls: ParsedMessage["entry"]["tool_calls"] = null;
		let tool_results: ParsedMessage["entry"]["tool_results"] = null;

		if (typeof content === "string") {
			text = content;
		} else if (Array.isArray(content)) {
			const textParts: string[] = [];
			const thinkParts: string[] = [];
			const calls: NonNullable<ParsedMessage["entry"]["tool_calls"]> = [];

			for (const part of content) {
				if (!part || typeof part !== "object") continue;
				const p = part as Record<string, unknown>;
				if (p.type === "text" && typeof p.text === "string") textParts.push(p.text);
				else if (p.type === "thinking" && typeof p.thinking === "string") thinkParts.push(p.thinking);
				else if (p.type === "toolCall") {
					calls.push({
						id: String(p.id ?? ""),
						name: String(p.name ?? ""),
						arguments: (p.arguments as Record<string, unknown>) ?? {},
					});
				}
			}

			if (textParts.length > 0) text = textParts.join("\n");
			if (thinkParts.length > 0) thinking = thinkParts.join("\n");
			if (calls.length > 0) tool_calls = calls;
		}

		// Tool results
		if (role === "toolResult") {
			const textLen = text?.length ?? 0;
			tool_results = [{
				toolCallId: String(msg.toolCallId ?? ""),
				toolName: String(msg.toolName ?? ""),
				isError: Boolean(msg.isError),
				textLength: textLen,
			}];
		}

		const usage = role === "assistant" ? extractUsage(msg, "pi") : null;
		const model = role === "assistant" ? extractModel(msg) : null;
		const costUsd = role === "assistant" ? extractCostUsd(msg.usage as Record<string, unknown> | undefined) : null;

		// The host's own verdict on how the generation ended, and — when it ended
		// badly — why. Both are recorded verbatim: classification is an analyzer's
		// job, and sync must not decide in advance which failures matter.
		const stopReason = role === "assistant" ? extractStopReason(msg) : null;
		const errorMessage = role === "assistant" ? extractErrorMessage(msg) : null;

		// Pi writes one line per assistant response, so the line's own id already
		// identifies the billed call.
		return {
			kind: "message",
			entry: { id, parentId, timestamp, role: role as MessageRole, text, thinking, tool_calls, tool_results, usage, model, costUsd, providerMessageId: role === "assistant" ? id : null, stopReason, errorMessage },
		};
	}

	// Other message-like types (bashExecution, branch_summary, compactionSummary, custom_message)
	if (type && obj.id) {
		const id = String(obj.id);
		const parentId = (obj.parentId as string) ?? null;
		const timestamp = (obj.timestamp as string) ?? null;

		// Try to get message.role or use the type itself as the role
		const msg = obj.message as Record<string, unknown> | undefined;
		const role = (msg?.role as string) ?? type;

		let text: string | null = null;
		if (msg) {
			if (typeof msg.content === "string") text = msg.content;
			else if (msg.summary) text = String(msg.summary);
			else if (msg.command) text = `${msg.command}\n${msg.output ?? ""}`;
		} else {
			if (obj.summary) text = String(obj.summary);
		}

		return {
			kind: "message",
			entry: { id, parentId, timestamp, role: role as MessageRole, text, thinking: null, tool_calls: null, tool_results: null, usage: null, model: null, costUsd: null, providerMessageId: null, stopReason: null, errorMessage: null },
		};
	}

	return null;
}

// ─── Claude tool-name normalization ───

/**
 * Map Claude Code capitalized tool names to the Pi lowercase convention
 * so the trajectory analyzer and turn-pair builder see a uniform vocabulary.
 * All downstream code (arg-parser, detectors, build.ts) expects lowercase.
 */
const CLAUDE_TOOL_NAME_MAP: Record<string, string> = {
	"Bash": "bash",
	"Read": "read",
	"Write": "write",
	"Edit": "edit",
	"Glob": "glob",
	"Grep": "grep",
	"WebSearch": "webSearch",
	"WebFetch": "webFetch",
	"Task": "task",
	"TodoWrite": "todoWrite",
	"NotebookEdit": "notebookEdit",
};

function normalizeClaudeToolName(name: string): string {
	return CLAUDE_TOOL_NAME_MAP[name] ?? name;
}

// ─── Claude line parser ───

/**
 * Build a `tool_use_id → toolName` map from every assistant message in a Claude
 * session. Claude's `tool_result` blocks carry only a `tool_use_id`, so the tool
 * name has to be resolved from the matching `tool_use` block in the preceding
 * assistant message (issue #30). Names are normalized (Read → read) to match the
 * assistant-side `tool_calls`. Cheap pre-pass; safe to run over all lines before
 * the resume point so incremental syncs still resolve names for spanning pairs.
 */
export function buildClaudeToolNameMap(lines: string[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (obj.type !== "assistant") continue;
		const msg = obj.message as Record<string, unknown> | undefined;
		const content = msg?.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const p = part as Record<string, unknown>;
			if (p.type === "tool_use" && typeof p.id === "string" && p.id) {
				map.set(p.id, normalizeClaudeToolName(String(p.name ?? "")));
			}
		}
	}
	return map;
}

/** Parse a line from a Claude Code JSONL session file. */
export function parseClaudeLine(line: string, toolNamesById?: Map<string, string>): ParsedLine | null {
	if (!line.trim()) return null;

	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(line);
	} catch {
		return null;
	}

	if (typeof obj !== "object" || obj === null) return null;

	const type = obj.type as string | undefined;

	// Session header: Claude doesn't have one — extract metadata from first line patterns.
	// We handle this at the sync level instead.

	// User message
	if (type === "user") {
		// Skip meta-only user lines (slash-command expansions, caveats, command stdout)
		// that carry no user intent and create spurious turn boundaries.
		if (obj.isMeta === true) return null;

		if (!obj.uuid) return null; // id is required for identity

		const msg = obj.message as Record<string, unknown> | undefined;
		if (!msg) return null;

		const uuid = String(obj.uuid);
		const parentUuid = (obj.parentUuid as string) ?? null;
		const timestamp = (obj.timestamp as string) ?? null;

		let text: string | null = null;
		let tool_results: ParsedMessage["entry"]["tool_results"] = null;

		const content = msg.content;
		if (typeof content === "string") {
			text = content;
		} else if (Array.isArray(content)) {
			const textParts: string[] = [];
			const results: NonNullable<ParsedMessage["entry"]["tool_results"]> = [];

			for (const part of content) {
				if (!part || typeof part !== "object") continue;
				const p = part as Record<string, unknown>;
				if (p.type === "text" && typeof p.text === "string") {
					textParts.push(p.text);
				} else if (p.type === "tool_result") {
					const resultContent = p.content;
					let resultText = "";
					if (typeof resultContent === "string") {
						resultText = resultContent;
					} else if (Array.isArray(resultContent)) {
						resultText = resultContent
							.filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null && c.type === "text")
							.map(c => String(c.text ?? ""))
							.join("\n");
					}
					const toolUseId = String(p.tool_use_id ?? "");
					results.push({
						toolCallId: toolUseId,
						toolName: toolNamesById?.get(toolUseId) ?? "",
						isError: Boolean(p.is_error),
						textLength: resultText.length,
					});
					if (resultText) textParts.push(resultText);
				}
			}

			if (textParts.length > 0) text = textParts.join("\n");
			if (results.length > 0) tool_results = results;
		}

		// Determine role: user message with tool_results → treat as toolResult
		const role = tool_results && tool_results.length > 0 ? "toolResult" : "user";

		return {
			kind: "message",
			entry: { id: uuid, parentId: parentUuid, timestamp, role, text, thinking: null, tool_calls: null, tool_results, usage: null, model: null, costUsd: null, providerMessageId: null, stopReason: null, errorMessage: null },
		};
	}

	// Assistant message
	if (type === "assistant") {
		if (!obj.uuid) return null; // id is required for identity

		const msg = obj.message as Record<string, unknown> | undefined;
		if (!msg) return null;

		const uuid = String(obj.uuid);
		const parentUuid = (obj.parentUuid as string) ?? null;
		const timestamp = (obj.timestamp as string) ?? null;

		let text: string | null = null;
		let thinking: string | null = null;
		let tool_calls: ParsedMessage["entry"]["tool_calls"] = null;

		const content = msg.content;
		if (Array.isArray(content)) {
			const textParts: string[] = [];
			const thinkParts: string[] = [];
			const calls: NonNullable<ParsedMessage["entry"]["tool_calls"]> = [];

			for (const part of content) {
				if (!part || typeof part !== "object") continue;
				const p = part as Record<string, unknown>;
				if (p.type === "text" && typeof p.text === "string") {
					textParts.push(p.text);
				} else if (p.type === "thinking" && typeof p.thinking === "string") {
					thinkParts.push(p.thinking);
				} else if (p.type === "tool_use") {
					calls.push({
						id: String(p.id ?? ""),
						name: normalizeClaudeToolName(String(p.name ?? "")),
						arguments: (p.input as Record<string, unknown>) ?? {},
					});
				}
			}

			if (textParts.length > 0) text = textParts.join("\n");
			if (thinkParts.length > 0) thinking = thinkParts.join("\n");
			if (calls.length > 0) tool_calls = calls;
		} else if (typeof content === "string") {
			text = content;
		}

		const usage = extractUsage(msg, "claude");
		const model = extractModel(msg);
		// Claude Code records no per-message dollar cost, so billed cost stays null.
		const costUsd = null;
		// One assistant response becomes a line per content block, each repeating
		// that response's usage. `message.id` is what ties them back together.
		const providerMessageId = typeof msg.id === "string" ? msg.id : null;

		// Claude Code has no `errorMessage` field: an API failure is written as an
		// ordinary assistant line flagged `isApiErrorMessage`, whose text *is* the
		// error. Normalising it to the same two columns is what lets one analyzer
		// read turn failures from both hosts.
		const isApiError = obj.isApiErrorMessage === true;
		const stopReason = isApiError ? "error" : extractStopReason(msg);
		const errorMessage = isApiError && text ? text : null;

		return {
			kind: "message",
			entry: { id: uuid, parentId: parentUuid, timestamp, role: "assistant", text, thinking, tool_calls, tool_results: null, usage, model, costUsd, providerMessageId, stopReason, errorMessage },
		};
	}

	// ai-title is session metadata, not a conversation turn — skip it here.
	// It is extracted by parseClaudeSessionMeta (called from syncClaudeSession).
	if (type === "ai-title") return null;

	return null;
}

/** Parse session metadata from the first few lines of a Claude session file. */
export function parseClaudeSessionMeta(lines: string[]): ClaudeSessionMeta | null {
	if (lines.length === 0) return null;

	let title: string | null = null;
	let timestamp: string | null = null;
	let cwd: string | null = null;

	for (const line of lines) {
		if (!line.trim()) continue;

		let obj: Record<string, unknown>;
		try { obj = JSON.parse(line); } catch { continue; }

		const type = obj.type as string | undefined;

		if (type === "ai-title" && obj.aiTitle) {
			title = String(obj.aiTitle);
		}

		if (type === "user" || type === "assistant") {
			if (!timestamp && obj.timestamp) {
				timestamp = String(obj.timestamp);
			}
			if (!cwd && typeof obj.cwd === "string" && obj.cwd) {
				cwd = obj.cwd;
			}
			// Early exit once we have both
			if (timestamp && cwd) break;
		}
	}

	return { title, timestamp, cwd };
}

// ─── Usage extraction ───

/**
 * Extract token usage from an assistant message in either Pi or Claude format.
 *
 * Pi format:
 *   message.usage = { input, output, cacheRead, cacheWrite, totalTokens }
 *
 * Claude format:
 *   message.usage = { input_tokens, output_tokens, cache_read_input_tokens,
 *                      cache_creation_input_tokens }
 */
export function extractUsage(msg: Record<string, unknown>, source: SessionSource): UsageInfo | null {
	const usage = msg.usage as Record<string, unknown> | undefined;
	if (!usage || typeof usage !== "object") return null;

	if (source === "claude") {
		const input = safeNum(usage.input_tokens);
		const output = safeNum(usage.output_tokens);
		const cacheRead = safeNum(usage.cache_read_input_tokens);
		const cacheWrite = safeNum(usage.cache_creation_input_tokens);
		const totalTokens = input + output;
		if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null;
		return { input, output, cacheRead, cacheWrite, totalTokens };
	}

	// Pi format
	const input = safeNum(usage.input);
	const output = safeNum(usage.output);
	const cacheRead = safeNum(usage.cacheRead);
	const cacheWrite = safeNum(usage.cacheWrite);
	const totalTokens = safeNum(usage.totalTokens) || input + output;
	if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null;
	return { input, output, cacheRead, cacheWrite, totalTokens };
}

function safeNum(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Extract the serving model from an assistant message.
 *
 * Pi writes it at `message.model` (falling back to `message.responseModel`);
 * Claude Code writes it at `message.model`. Omitted or empty → null.
 */
function extractModel(msg: Record<string, unknown>): string | null {
	const raw = msg.model ?? msg.responseModel;
	return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * Extract the billed dollar cost from an assistant message's usage, or null.
 *
 * Pi records a per-message cost breakdown at `usage.cost` with a `total` value
 * in dollars; Claude Code records no dollar cost at all. Cost is money and must
 * never be guessed, so an unrecorded amount stays null.
 *
 * A recorded `total` of exactly 0 is collapsed to null too: Pi defaults every
 * cost bucket to 0 when it has not priced a message, so a zero is
 * indistinguishable from "no cost recorded" — and a silent 0 would read as
 * "this was free" to every downstream consumer (#71 ranks by cost). Only a
 * strictly positive recorded amount is treated as real money.
 */
function extractCostUsd(usage: Record<string, unknown> | undefined): number | null {
	const total = (usage?.cost as Record<string, unknown> | undefined)?.total;
	return typeof total === "number" && Number.isFinite(total) && total > 0 ? total : null;
}

/**
 * The host's recorded stop reason for an assistant generation.
 *
 * Pi writes `message.stopReason` (`toolUse` | `stop` | `error` | `length` |
 * `aborted` | `pending`); Claude Code writes `message.stop_reason`
 * (`tool_use` | `end_turn` | `stop_sequence` | `max_tokens`). The two
 * vocabularies are *not* unified here — sync records what the host said, and
 * the failure-class catalogue is the single place that interprets it.
 */
function extractStopReason(msg: Record<string, unknown>): string | null {
	const raw = msg.stopReason ?? msg.stop_reason;
	return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * The host's recorded error text for a failed assistant generation, or null.
 *
 * Pi writes it at `message.errorMessage`. It is stored verbatim: it is the
 * only evidence of *why* a turn produced nothing, and truncating or
 * pre-classifying it here would decide, in the ingest layer, which failures an
 * analyzer is allowed to see.
 */
function extractErrorMessage(msg: Record<string, unknown>): string | null {
	const raw = msg.errorMessage;
	return typeof raw === "string" && raw.length > 0 ? raw : null;
}
