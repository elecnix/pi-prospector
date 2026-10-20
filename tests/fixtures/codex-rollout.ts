/**
 * Synthetic Codex rollout fixtures.
 *
 * A Codex rollout file is a JSONL file whose first line is a `session_meta`
 * record and whose remaining lines are `turn_context`, `response_item`,
 * `token_usage_record` and `event_msg` records. Every id, path, model name and
 * prompt in this file is invented: the shapes are measured, the content is
 * not. Nothing here is copied from a real session.
 *
 * The builders mirror the shapes the real corpus has, so a parser that reads
 * these fixtures reads the real thing:
 *
 *   - a `token_usage_record` closes one generation;
 *   - a tool call's result arrives in the *next* generation;
 *   - the host's own context (AGENTS.md, environment block) is written into the
 *     transcript as a `user` message, distinguished by its content kind.
 */

/** A uuid-shaped id derived from a readable label, so a fixture reads by scenario. */
function fixtureId(label: string): string {
	const hash = (seed: number): string => {
		let x = seed >>> 0;
		for (const ch of label) {
			x ^= ch.charCodeAt(0);
			x = Math.imul(x, 0x01000193) >>> 0;
		}
		return x.toString(16).padStart(8, "0");
	};
	const hex = hash(0x811c9dc5) + hash(0x7f4a7c15) + hash(0x94d049bb) + hash(0x27220a95);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The file name Codex gives a rollout file: `rollout-<timestamp>-<uuid>.jsonl`. */
export function codexRolloutFileName(label: string, timestamp = "2026-03-04T09-15-00"): string {
	return `rollout-${timestamp}-${fixtureId(label)}.jsonl`;
}

/** The session id a fixture's `session_meta` carries. */
export function codexSessionId(label: string): string {
	return fixtureId(label);
}

export interface CodexMetaOptions {
	cwd?: string;
	timestamp?: string;
	cliVersion?: string;
	originator?: string;
	modelProvider?: string;
	/** A delegated agent's own session carries its parent's id. */
	parentThreadId?: string;
	forkedFromId?: string;
	agentNickname?: string;
}

/** The `session_meta` line every rollout file opens with. */
export function codexMetaLine(label: string, options: CodexMetaOptions = {}): string {
	const payload: Record<string, unknown> = {
		id: codexSessionId(label),
		session_id: codexSessionId(label),
		timestamp: options.timestamp ?? "2026-03-04T09:15:00.000Z",
		cwd: options.cwd ?? "/home/tester/workspace/notes-app",
		originator: options.originator ?? "codex-tui",
		cli_version: options.cliVersion ?? "0.163.0",
		source: "cli",
		thread_source: "user",
		model_provider: options.modelProvider ?? "openai",
		history_mode: "paginated",
	};
	if (options.parentThreadId) payload["parent_thread_id"] = options.parentThreadId;
	if (options.forkedFromId) payload["forked_from_id"] = options.forkedFromId;
	if (options.agentNickname) payload["agent_nickname"] = options.agentNickname;
	return JSON.stringify({ type: "session_meta", timestamp: options.timestamp ?? "2026-03-04T09:15:00.000Z", payload });
}

/** A `turn_context` line: the turn's id and the model serving it. */
export function codexTurnContextLine(turnId: string, model: string, cwd = "/home/tester/workspace/notes-app"): string {
	return JSON.stringify({
		type: "turn_context",
		timestamp: "2026-03-04T09:15:01.000Z",
		payload: { turn_id: turnId, cwd, model, approval_policy: "on-request" },
	});
}

/** A `task_started` event line. */
export function codexTaskStartedLine(turnId: string): string {
	return JSON.stringify({
		type: "event_msg",
		timestamp: "2026-03-04T09:15:00.500Z",
		payload: { type: "task_started", turn_id: turnId, model_context_window: 272000 },
	});
}

/** A `task_complete` event line. */
export function codexTaskCompleteLine(turnId: string, lastAgentMessage = ""): string {
	return JSON.stringify({
		type: "event_msg",
		timestamp: "2026-03-04T09:16:00.000Z",
		payload: { type: "task_complete", turn_id: turnId, last_agent_message: lastAgentMessage },
	});
}

/** A `turn_aborted` event line — the host's record of an abandoned turn. */
export function codexTurnAbortedLine(turnId: string, reason = "interrupted"): string {
	return JSON.stringify({
		type: "event_msg",
		timestamp: "2026-03-04T09:16:30.000Z",
		payload: { type: "turn_aborted", turn_id: turnId, reason },
	});
}

export interface CodexMessageOptions {
	/** The host's own content kinds, as the real corpus records them. */
	kinds?: string[];
	/** The turn the message belongs to; omitted in the older rollout format. */
	turnId?: string;
}

/** A `response_item` message line. */
export function codexMessageLine(
	role: "user" | "assistant" | "developer",
	text: string,
	options: CodexMessageOptions = {},
): string {
	const passthrough: Record<string, unknown> = {};
	if (options.turnId) passthrough["turn_id"] = options.turnId;
	if (options.kinds) passthrough["content_item_kinds"] = options.kinds;
	const payload: Record<string, unknown> = {
		type: "message",
		role,
		content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
	};
	if (Object.keys(passthrough).length > 0) {
		payload["internal_chat_message_metadata_passthrough"] = passthrough;
	}
	return JSON.stringify({ type: "response_item", timestamp: "2026-03-04T09:15:02.000Z", payload });
}

/** A `response_item` reasoning line — the model's private thinking. */
export function codexReasoningLine(text: string, turnId?: string): string {
	const payload: Record<string, unknown> = {
		type: "reasoning",
		content: [{ type: "reasoning_text", text }],
		summary: [],
	};
	if (turnId) {
		payload["internal_chat_message_metadata_passthrough"] = { turn_id: turnId, content_item_kinds: ["reasoning"] };
	}
	return JSON.stringify({ type: "response_item", timestamp: "2026-03-04T09:15:03.000Z", payload });
}

/** A `response_item` function_call line. `arguments` is a JSON string, as Codex writes it. */
export function codexFunctionCallLine(name: string, callId: string, args: Record<string, unknown>, turnId?: string): string {
	const payload: Record<string, unknown> = {
		type: "function_call",
		id: `fc_${callId}`,
		call_id: callId,
		name,
		arguments: JSON.stringify(args),
	};
	if (turnId) payload["internal_chat_message_metadata_passthrough"] = { turn_id: turnId };
	return JSON.stringify({ type: "response_item", timestamp: "2026-03-04T09:15:04.000Z", payload });
}

/** A `response_item` custom_tool_call line. `input` is a plain string, as Codex writes it. */
export function codexCustomToolCallLine(name: string, callId: string, input: string, turnId?: string): string {
	const payload: Record<string, unknown> = {
		type: "custom_tool_call",
		id: `ctc_${callId}`,
		call_id: callId,
		name,
		input,
	};
	if (turnId) payload["internal_chat_message_metadata_passthrough"] = { turn_id: turnId };
	return JSON.stringify({ type: "response_item", timestamp: "2026-03-04T09:15:04.000Z", payload });
}

/** A `response_item` function_call_output line — the result of one call. */
export function codexFunctionCallOutputLine(callId: string, output: string, turnId?: string): string {
	const payload: Record<string, unknown> = {
		type: "function_call_output",
		id: `fco_${callId}`,
		call_id: callId,
		output,
	};
	if (turnId) payload["internal_chat_message_metadata_passthrough"] = { turn_id: turnId };
	return JSON.stringify({ type: "response_item", timestamp: "2026-03-04T09:15:05.000Z", payload });
}

export interface CodexUsageOptions {
	input?: number;
	output?: number;
	cachedInput?: number;
	cacheWrite?: number;
	reasoningOutput?: number;
	/** The cumulative usage of the whole turn, as Codex records it alongside. */
	turnInput?: number;
	turnOutput?: number;
	turnCachedInput?: number;
	turnCacheWrite?: number;
	turnReasoningOutput?: number;
}

/** A `token_usage_record` line: the per-call usage that closes one generation. */
export function codexUsageRecordLine(turnId: string, responseId: string, options: CodexUsageOptions = {}): string {
	const input = options.input ?? 1200;
	const output = options.output ?? 180;
	const cached = options.cachedInput ?? 0;
	const cacheWrite = options.cacheWrite ?? 0;
	const reasoning = options.reasoningOutput ?? 0;
	const total = input + output;
	const turnInput = options.turnInput ?? input;
	const turnOutput = options.turnOutput ?? output;
	const turnCached = options.turnCachedInput ?? cached;
	const turnCacheWrite = options.turnCacheWrite ?? cacheWrite;
	const turnReasoning = options.turnReasoningOutput ?? reasoning;
	const turnTotal = turnInput + turnOutput;
	return JSON.stringify({
		type: "token_usage_record",
		timestamp: "2026-03-04T09:15:06.000Z",
		payload: {
			response_id: responseId,
			session_id: codexSessionId("usage"),
			thread_id: codexSessionId("usage"),
			turn_id: turnId,
			root_turn_id: turnId,
			usage: {
				input_tokens: input,
				cached_input_tokens: cached,
				cache_write_input_tokens: cacheWrite,
				output_tokens: output,
				reasoning_output_tokens: reasoning,
				total_tokens: total,
			},
			turn_token_usage: {
				input_tokens: turnInput,
				cached_input_tokens: turnCached,
				cache_write_input_tokens: turnCacheWrite,
				output_tokens: turnOutput,
				reasoning_output_tokens: turnReasoning,
				total_tokens: turnTotal,
			},
		},
	});
}

/** A `compacted` line — the host's record of a context compaction. */
export function codexCompactedLine(summary: string): string {
	return JSON.stringify({
		type: "compacted",
		timestamp: "2026-03-04T09:20:00.000Z",
		payload: { message: summary },
	});
}

/**
 * An `item_completed` event carrying a message — the older rollout format's
 * record of the conversation.
 *
 * The older format writes the full message into the event's `item`, and the
 * event carries the turn it belongs to.
 */
export function codexItemCompletedLine(turnId: string, itemType: "UserMessage" | "AgentMessage", text: string, itemId: string): string {
	return JSON.stringify({
		type: "event_msg",
		timestamp: "2026-03-04T09:15:07.000Z",
		payload: {
			type: "item_completed",
			turn_id: turnId,
			item: { type: itemType, id: itemId, content: [{ type: itemType === "AgentMessage" ? "Text" : "text", text }] },
		},
	});
}

/** An `item_completed` event carrying a command the host ran. */
export function codexCommandExecutionLine(turnId: string, itemId: string, command: string, exitCode: number, output: string): string {
	return JSON.stringify({
		type: "event_msg",
		timestamp: "2026-03-04T09:15:08.000Z",
		payload: {
			type: "item_completed",
			turn_id: turnId,
			item: { type: "CommandExecution", id: itemId, command, exit_code: exitCode, aggregated_output: output },
		},
	});
}
