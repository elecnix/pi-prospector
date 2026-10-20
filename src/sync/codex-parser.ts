/**
 * The Codex line parser — the one place that knows Codex's own vocabulary.
 *
 * A Codex rollout file is a JSONL file whose lines are records with a `type`
 * and a `payload`. The shapes this parser reads were measured over a live
 * corpus of 159 rollout files (48 764 lines, 9 627 `response_item`s, 1 542
 * `token_usage_record`s); the counts that shaped the design are in the comments
 * below.
 *
 * ## The two rollout formats
 *
 * Codex has written two shapes of rollout file, and both are on disk today:
 *
 *   - **The current format** (76 of 159 files) records a `function_call` beside
 *     the result it answers, and stamps every item with the turn it belongs to
 *     in `internal_chat_message_metadata_passthrough.turn_id`. Its
 *     `token_usage_record` closes one generation: the items since the previous
 *     usage record are the model's one response.
 *   - **The older format** (83 of 159 files) records the conversation in
 *     `item_completed` events, whose `item` carries the full message. Its
 *     `response_item` message records are a *sample* of the same conversation
 *     (1 463 records against 4 708 events), and it never records the *call* of
 *     a tool — only the result, which is therefore an orphan.
 *
 * The parser reads both, and says so rather than guessing. An orphan result is
 * indexed as a tool result with no call, which every analyzer already treats
 * as "a call whose name was never recorded" rather than as a failure.
 *
 * ## The three facts the whole design rests on
 *
 *   1. **A `token_usage_record` closes one generation.** The items between the
 *      previous usage record and this one are the model's one response: some
 *      reasoning, maybe a message, and the tool calls it asked for. Measured:
 *      every usage record is preceded by at least one item, and two usage
 *      records are never adjacent.
 *   2. **A tool result arrives in the next generation.** The call is in one
 *      generation, the result that answers it in the next. So a call and its
 *      result are not siblings in the file — the pair has to be joined by the
 *      provider's own `call_id`, the same way Claude Code's `tool_use_id` is.
 *   3. **The host writes its own context into the transcript as `user`
 *      messages.** The repository's AGENTS.md body, the environment block and
 *      the permission instructions are all `role: "user"` records. Only a
 *      message whose content kinds include `user.text` is a human speaking.
 *
 * The usage record carries two buckets: `usage` is the per-call usage of that
 * generation, `turn_token_usage` is the cumulative total of the whole turn.
 * Measured on the live corpus, the two differ on 1 011 of 1 103 records — so
 * folding them together would bill every generation twice.
 */

import type { MessageRole, UsageInfo } from "../types.js";

/** One parsed rollout line, in the shapes the index understands. */
export type CodexLine =
	| { kind: "message"; entry: CodexMessage }
	| { kind: "tool-call"; entry: CodexToolCall }
	| { kind: "tool-result"; entry: CodexToolResult }
	| { kind: "command"; entry: CodexCommand }
	| { kind: "usage"; entry: CodexUsage }
	| { kind: "model"; entry: CodexModel }
	| { kind: "compaction"; entry: CodexCompaction }
	| { kind: "aborted"; entry: CodexAborted };

export interface CodexMessage {
	/** The message's id, when the host recorded one. */
	id: string | null;
	role: MessageRole;
	text: string | null;
	/** The model's private reasoning, when the host recorded it. */
	thinking: string | null;
	timestamp: string | null;
	/** The turn the message belongs to, when the host recorded one. */
	turnId: string | null;
}

/**
 * Which record stream a rollout file's conversation lives in.
 *
 * Codex has written two shapes of rollout file, and both are on disk:
 *
 *   - **The current format** records the conversation in `response_item`
 *     messages, each stamped with the turn it belongs to. Its `item_completed`
 *     events duplicate those items.
 *   - **The older format** records the conversation in `item_completed` events,
 *     whose `item` carries the full message. Its `response_item` messages are a
 *     *sample* of the same conversation — 1 463 records against 4 708 events —
 *     and it never records the *call* of a tool, only the result.
 *
 * So the two streams are read from different sources in the two formats, and
 * reading both would double every message.
 */
export type CodexFormat = "current" | "older";

/**
 * The format a rollout file is written in.
 *
 * The marker is the turn stamp the current format puts on every one of its
 * items. Measured on the live corpus, the stamp is all-or-nothing per file: 76
 * files have it on every item, 85 have it on none, and no file has it on some
 * items but not others. The current format also records the tool *call*
 * beside its result, which the older format never does — 0 of the 85 older
 * files carry a single call.
 *
 * The whole file is read to decide, because the answer cannot be known from
 * its first lines: the older format's first records are a `session_meta`, a
 * `task_started` and a `turn_context` — all of which the current format also
 * writes.
 */
export function codexFormatOf(lines: string[]): CodexFormat {
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (obj["type"] !== "response_item") continue;
		const payload = (obj["payload"] ?? {}) as Record<string, unknown>;
		if (payload["internal_chat_message_metadata_passthrough"]) return "current";
	}
	return "older";
}

export interface CodexToolCall {
	/** The provider's call id — the key a result is joined back on. */
	callId: string;
	name: string;
	arguments: Record<string, unknown>;
	timestamp: string | null;
	turnId: string | null;
}

export interface CodexToolResult {
	/** The provider's call id — the key it is joined back on. */
	callId: string;
	/** The result text, kept so a failure's cause can be read out of it. */
	text: string;
	timestamp: string | null;
	turnId: string | null;
}

/**
 * A command the host ran, from its `CommandExecution` event.
 *
 * The current format records the command's result as a `function_call_output`
 * item, and the event carries the same id — so the event is the only record of
 * the exit code when the result's own text does not carry one. The older
 * format records no result item at all, so the event is the *only* record of
 * the command and its outcome.
 */
export interface CodexCommand {
	/** The command's id — the key its result is joined back on. */
	callId: string;
	/** The command line, as the host recorded it. */
	command: string;
	/** The exit code, or null when the host recorded none. */
	exitCode: number | null;
	/** The output the host recorded. */
	output: string;
	timestamp: string | null;
	turnId: string | null;
}

export interface CodexUsage {
	/** The per-call usage of the generation this record closes. */
	usage: UsageInfo;
	/** The provider's response id — several rows may share one. */
	responseId: string | null;
	turnId: string | null;
}

export interface CodexModel {
	/** The model serving the turn. */
	model: string;
	turnId: string | null;
}

export interface CodexCompaction {
	/** The summary the host wrote when it compacted the conversation. */
	text: string;
	timestamp: string | null;
}

export interface CodexAborted {
	/** The turn the host abandoned. */
	turnId: string | null;
	timestamp: string | null;
}

/**
 * The content kinds that mark a `user` message as the human speaking.
 *
 * Codex records the kind of every content item it files. `user.text` is a
 * human's words; everything else in a user message — the AGENTS.md body, the
 * environment block, a subagent notification, an abort notice — is the host's
 * own context and must not open a turn.
 */
const HUMAN_CONTENT_KIND = "user.text";

/**
 * The opening shapes of a context block Codex wrote before it started recording
 * content kinds.
 *
 * The older rollout format files no kind list at all, so the only way to tell
 * the host's context from a human's turn is the shape of the text itself.
 * These are the openings the live corpus uses, measured across every user
 * message that carried no kind list.
 */
const CONTEXT_BLOCK_PREFIXES: readonly string[] = [
	"# AGENTS.md instructions",
	"<environment_context>",
	"<user_shell_command>",
	"<command-name>",
	"<command-message>",
	"<local-command-caveat>",
	"<multi_agent_role>",
	"<skills_instructions>",
	"<guidelines>",
	"<task-notification>",
	"<task>",
	"<skill",
	"<file ",
	"The following is the Codex agent history",
];

/**
 * Parse one rollout line. Returns null for a line this parser does not own.
 *
 * `format` decides which stream the conversation is read from: the current
 * format's messages live in `response_item` records, the older format's in
 * `item_completed` events. Reading both in either format would double every
 * message.
 */
export function parseCodexLine(
	line: string,
	timestamp: string | null,
	format: CodexFormat = "current",
	sessionId: string | null = null,
): CodexLine | null {
	const trimmed = line.trim();
	if (!trimmed) return null;

	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(trimmed) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (typeof obj !== "object" || obj === null) return null;

	const type = typeof obj["type"] === "string" ? (obj["type"] as string) : "";
	const payload = (obj["payload"] ?? {}) as Record<string, unknown>;
	const at = typeof obj["timestamp"] === "string" ? (obj["timestamp"] as string) : timestamp;

	switch (type) {
		case "response_item":
			// In the older format the response items are a sample of the
			// conversation the events already carry, so they are not read as
			// messages there. The tool calls and their results are read in
			// both formats: the older format records the results.
			if (format === "older" && (payload["type"] === "message" || payload["type"] === "reasoning")) {
				return null;
			}
			return parseResponseItem(payload, at, sessionId);
		case "event_msg":
			// In the current format the message events duplicate the items, but
			// the command event is read in both formats: it is the host's
			// record of the exit code, and in the older format it is the only
			// record of the command at all.
			if (format === "current" && payload["type"] === "item_completed") {
				const item = payload["item"];
				if (!item || typeof item !== "object") return null;
				const kind = (item as Record<string, unknown>)["type"];
				if (kind !== "CommandExecution") return null;
				return parseCompletedItem(item as Record<string, unknown>, payload, timestamp, sessionId);
			}
			return parseEvent(payload, at, sessionId);
		case "turn_context":
			return parseTurnContext(payload);
		case "token_usage_record":
			return parseUsageRecord(payload);
		case "compacted":
			return parseCompaction(payload, at);
		default:
			return null;
	}
}

/** The turn id a payload carries, when the host recorded one. */
function turnIdOf(payload: Record<string, unknown>): string | null {
	const meta = payload["internal_chat_message_metadata_passthrough"];
	if (meta && typeof meta === "object") {
		const turnId = (meta as Record<string, unknown>)["turn_id"];
		if (typeof turnId === "string" && turnId) return turnId;
	}
	return null;
}

/** A `response_item` — a message, a reasoning block, a tool call or its result. */
function parseResponseItem(
	payload: Record<string, unknown>,
	timestamp: string | null,
	sessionId: string | null,
): CodexLine | null {
	const kind = typeof payload["type"] === "string" ? (payload["type"] as string) : "";
	const turnId = turnIdOf(payload);

	switch (kind) {
		case "message":
			return parseMessage(payload, timestamp, turnId, sessionId);
		case "reasoning":
			return parseReasoning(payload, timestamp, turnId);
		case "function_call":
		case "custom_tool_call":
			return parseToolCall(payload, timestamp, turnId, kind === "custom_tool_call");
		case "function_call_output":
		case "custom_tool_call_output":
			return parseToolResult(payload, timestamp, turnId);
		case "web_search_call":
			return parseToolCall(
				{ ...payload, name: "web_search", arguments: JSON.stringify(payload["action"] ?? {}) },
				timestamp,
				turnId,
				false,
			);
		default:
			return null;
	}
}

/**
 * An `event_msg` — the host's own running commentary.
 *
 * Only the `item_completed` event carries a conversation item, and only in the
 * older rollout format: there, the event's `item` holds the full message,
 * while the `response_item` records are a sample of the same conversation.
 * In the current format the events duplicate the items, and the items carry
 * the ids, so the events are read only for what the items do not carry — the
 * turn id of an item that lacks one, and the exit code of a command.
 */
function parseEvent(payload: Record<string, unknown>, timestamp: string | null, sessionId: string | null): CodexLine | null {
	const kind = typeof payload["type"] === "string" ? (payload["type"] as string) : "";
	if (kind === "turn_aborted") {
		return {
			kind: "aborted",
			entry: {
				turnId: typeof payload["turn_id"] === "string" ? (payload["turn_id"] as string) : null,
				timestamp,
			},
		};
	}
	if (kind !== "item_completed") return null;
	const item = payload["item"];
	if (!item || typeof item !== "object") return null;
	return parseCompletedItem(item as Record<string, unknown>, payload, timestamp, sessionId);
}

/** An `item_completed` event's item. */
function parseCompletedItem(
	item: Record<string, unknown>,
	event: Record<string, unknown>,
	timestamp: string | null,
	sessionId: string | null,
): CodexLine | null {
	const type = typeof item["type"] === "string" ? (item["type"] as string) : "";
	const turnId = typeof event["turn_id"] === "string" ? (event["turn_id"] as string) : null;

	switch (type) {
		case "UserMessage": {
			const text = contentText(item["content"], "\n");
			if (text === null) return null;
			// The host's own context is filed as a user message. The event
			// carries no content kinds, so the text's own shape is the only
			// evidence of what it is.
			if (isContextBlock(text)) return null;
			return {
				kind: "message",
				entry: { id: scopedId(idOf(item), sessionId), role: "user", text, thinking: null, timestamp, turnId },
			};
		}
		case "AgentMessage": {
			const text = contentText(item["content"], "\n");
			if (text === null) return null;
			return {
				kind: "message",
				entry: { id: scopedId(idOf(item), sessionId), role: "assistant", text, thinking: null, timestamp, turnId },
			};
		}
		case "Reasoning": {
			const raw = item["raw_content"];
			const text = Array.isArray(raw)
				? raw.filter((p) => typeof p === "string").join("\n")
				: typeof raw === "string"
					? raw
					: null;
			if (text === null || text.trim().length === 0) return null;
			return {
				kind: "message",
				entry: { id: scopedId(idOf(item), sessionId), role: "assistant", text: null, thinking: text, timestamp, turnId },
			};
		}
		case "CommandExecution": {
			// A command the host ran. In the older format this is the only
			// record of the command; in the current format it carries the exit
			// code the result's own text may not.
			const callId = typeof item["id"] === "string" ? (item["id"] as string) : "";
			if (!callId) return null;
			return {
				kind: "command",
				entry: {
					callId,
					command: typeof item["command"] === "string" ? (item["command"] as string) : "",
					exitCode: typeof item["exit_code"] === "number" ? (item["exit_code"] as number) : null,
					output: typeof item["aggregated_output"] === "string" ? (item["aggregated_output"] as string) : "",
					timestamp,
					turnId,
				},
			};
		}
		default:
			return null;
	}
}

/** A `message` item. */
function parseMessage(
	payload: Record<string, unknown>,
	timestamp: string | null,
	turnId: string | null,
	sessionId: string | null,
): CodexLine | null {
	const role = typeof payload["role"] === "string" ? (payload["role"] as string) : "";
	if (role !== "user" && role !== "assistant") return null;

	const text = contentText(payload["content"], "\n");

	if (role === "user") {
		// The host's own context is filed as a user message. A message whose
		// content kinds name no human text is that context, whatever it says.
		if (!isHumanTurn(payload, text)) return null;
		return {
			kind: "message",
			entry: { id: scopedId(idOf(payload), sessionId), role: "user", text, thinking: null, timestamp, turnId },
		};
	}

	return {
		kind: "message",
		entry: { id: scopedId(idOf(payload), sessionId), role: "assistant", text, thinking: null, timestamp, turnId },
	};
}

/**
 * Whether a `user` message is the human speaking, rather than the host's own
 * context.
 *
 * Two ways to tell, in the order the corpus needs them. A message whose content
 * kinds name no `user.text` is the host's context — the kinds are recorded
 * precisely so this question has an answer. A message that records no kinds at
 * all is from the older rollout format, where the only evidence is the shape of
 * the text.
 */
function isHumanTurn(payload: Record<string, unknown>, text: string | null): boolean {
	const meta = payload["internal_chat_message_metadata_passthrough"];
	if (meta && typeof meta === "object") {
		const kinds = (meta as Record<string, unknown>)["content_item_kinds"];
		if (Array.isArray(kinds)) {
			return kinds.some((k) => k === HUMAN_CONTENT_KIND);
		}
	}
	// No kind list: fall back to the text's own shape.
	if (text === null) return false;
	return !isContextBlock(text);
}

/** Whether a message's text is one of the host's own context blocks. */
function isContextBlock(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length === 0) return false;
	return CONTEXT_BLOCK_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** A `reasoning` item — the model's private thinking. */
function parseReasoning(
	payload: Record<string, unknown>,
	timestamp: string | null,
	turnId: string | null,
): CodexLine | null {
	const content = contentText(payload["content"], "\n");
	const summary = contentText(payload["summary"], "\n");
	const thinking = content ?? summary;
	if (thinking === null) return null;
	return {
		kind: "message",
		entry: { id: idOf(payload), role: "assistant", text: null, thinking, timestamp, turnId },
	};
}

/** A tool call: a `function_call` or a `custom_tool_call`. */
function parseToolCall(
	payload: Record<string, unknown>,
	timestamp: string | null,
	turnId: string | null,
	custom: boolean,
): CodexLine | null {
	const callId = typeof payload["call_id"] === "string" ? (payload["call_id"] as string) : "";
	if (!callId) return null;
	const name = typeof payload["name"] === "string" ? (payload["name"] as string) : "";
	if (!name) return null;

	return {
		kind: "tool-call",
		entry: { callId, name, arguments: toolArguments(payload, custom), timestamp, turnId },
	};
}

/**
 * The arguments a tool call carries.
 *
 * A `function_call` writes its arguments as a JSON *string*; a `custom_tool_call`
 * writes its input as a plain string (an `apply_patch` body). Both are read into
 * the one shape the index stores, so an analyzer sees the same thing whichever
 * kind of call it was.
 */
function toolArguments(payload: Record<string, unknown>, custom: boolean): Record<string, unknown> {
	const raw = custom ? payload["input"] : payload["arguments"];
	if (typeof raw !== "string") {
		return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	}
	if (custom) {
		// A custom call's input is its body, not a JSON object.
		return { input: raw };
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		// A call whose arguments are not JSON still has a body; keeping it under
		// `input` is better than dropping it.
		return { input: raw };
	}
}

/** A tool result: a `function_call_output` or a `custom_tool_call_output`. */
function parseToolResult(
	payload: Record<string, unknown>,
	timestamp: string | null,
	turnId: string | null,
): CodexLine | null {
	const callId = typeof payload["call_id"] === "string" ? (payload["call_id"] as string) : "";
	if (!callId) return null;
	const output = payload["output"];
	let text: string;
	if (typeof output === "string") {
		text = output;
	} else if (output === undefined || output === null) {
		text = "";
	} else {
		text = JSON.stringify(output);
	}
	return { kind: "tool-result", entry: { callId, text, timestamp, turnId } };
}

/** A `turn_context` — the model serving the turn. */
function parseTurnContext(payload: Record<string, unknown>): CodexLine | null {
	const model = typeof payload["model"] === "string" ? (payload["model"] as string) : "";
	if (!model) return null;
	const turnId = typeof payload["turn_id"] === "string" ? (payload["turn_id"] as string) : null;
	return { kind: "model", entry: { model, turnId } };
}

/**
 * A `token_usage_record` — the per-call usage of the generation it closes.
 *
 * Only the `usage` bucket is read. The record also carries `turn_token_usage`,
 * the cumulative total of the whole turn; folding that in as well would bill
 * every generation of a turn once more.
 */
function parseUsageRecord(payload: Record<string, unknown>): CodexLine | null {
	const usage = payload["usage"];
	if (!usage || typeof usage !== "object") return null;
	const u = usage as Record<string, unknown>;

	const input = num(u["input_tokens"]);
	const output = num(u["output_tokens"]);
	const cacheRead = num(u["cached_input_tokens"]);
	const cacheWrite = num(u["cache_write_input_tokens"]);
	if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null;

	return {
		kind: "usage",
		entry: {
			usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output, cost: null },
			responseId: typeof payload["response_id"] === "string" ? (payload["response_id"] as string) : null,
			turnId: typeof payload["turn_id"] === "string" ? (payload["turn_id"] as string) : null,
		},
	};
}

/** A `compacted` record — the host's summary of a compacted conversation. */
function parseCompaction(payload: Record<string, unknown>, timestamp: string | null): CodexLine | null {
	const message = payload["message"];
	if (typeof message !== "string" || message.length === 0) return null;
	return { kind: "compaction", entry: { text: message, timestamp } };
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** The id a payload carries, when the host recorded one. */
function idOf(payload: Record<string, unknown>): string | null {
	const id = payload["id"];
	return typeof id === "string" && id ? id : null;
}

/**
 * An id the host recorded, scoped to the session it belongs to.
 *
 * The older rollout format names its event items `item-1`, `item-2` and so on
 * — a counter that restarts in every file. Measured on the live corpus, 669
 * call ids and many more item ids appear in more than one file, so an
 * unscoped id would make one session's row collide with another's and one of
 * them would be dropped.
 *
 * The scope is the session's own id, which every file carries and which no
 * other file shares.
 */
function scopedId(id: string | null, sessionId: string | null): string | null {
	if (!id) return null;
	return sessionId ? `${sessionId}-item-${id}` : `codex-item-${id}`;
}

/**
 * The text of a content array, joined.
 *
 * Codex writes a message's content as an array of parts, each with a `text`.
 * The two formats join the parts differently: the current format separates them
 * with a newline, the older format's events with nothing. A part that carries
 * an image rather than text contributes nothing.
 */
function contentText(content: unknown, separator: string): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const text = (part as Record<string, unknown>)["text"];
		if (typeof text === "string") parts.push(text);
	}
	return parts.length > 0 ? parts.join(separator) : null;
}

/**
 * Codex's own tool names, mapped onto the names the rest of the index uses.
 *
 * The trajectory analyzer compares calls by name and by their normalised
 * arguments, and every other analyzer reads a `bash` call as a shell command.
 * Codex calls its shell tool `exec_command` and its patch tool `apply_patch`;
 * without this mapping a Codex session's calls would be invisible to the
 * detectors that understand the other harnesses' names.
 *
 * A name this table does not know keeps its own — a tool the index has never
 * seen is still a fact about the session.
 */
const CODEX_TOOL_NAMES: Record<string, string> = {
	exec_command: "bash",
	shell: "bash",
	local_shell_call: "bash",
	apply_patch: "edit",
	apply_patch_freeform: "edit",
	read_file: "read",
	view_file: "read",
	list_dir: "glob",
	glob: "glob",
	grep: "grep",
	search: "grep",
};

/** The index-wide name for a Codex tool. */
export function codexToolName(name: string): string {
	return CODEX_TOOL_NAMES[name] ?? name;
}
