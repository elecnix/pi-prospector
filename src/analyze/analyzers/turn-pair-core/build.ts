/**
 * Turn-pair construction from a session's message stream.
 *
 * A *turn pair* is a single user message together with everything the agent did
 * in response, up to (but excluding) the next user message: assistant text,
 * thinking, tool calls, and tool results. Session-level entries (compaction or
 * branch summaries) are not part of any pair.
 */

import type { MessageRow } from "../../types.js";

export interface PairToolCall {
	name: string;
}

export interface PairToolResult {
	toolName: string;
	isError: boolean;
	textLength: number;
}

export interface TurnPair {
	/** Index of the pair within the session, 0-based. */
	index: number;
	/** The anchoring user message id. */
	userMessageId: string;
	/** All message ids covered by this pair (user + responses). */
	messageIds: string[];
	userText: string;
	assistantText: string;
	thinkingText: string;
	toolCalls: PairToolCall[];
	toolResults: PairToolResult[];
	/** The previous pair's user text, for repetition detection. */
	priorUserText: string | null;
	timestamp: string | null;
}

function parseToolCalls(json: string | null): PairToolCall[] {
	if (!json) return [];
	try {
		const arr = JSON.parse(json) as Array<{ name?: unknown }>;
		if (!Array.isArray(arr)) return [];
		return arr.map((c) => ({ name: typeof c.name === "string" ? c.name : "" }));
	} catch {
		return [];
	}
}

function parseToolResults(json: string | null): PairToolResult[] {
	if (!json) return [];
	try {
		const arr = JSON.parse(json) as Array<{ toolName?: unknown; isError?: unknown; textLength?: unknown }>;
		if (!Array.isArray(arr)) return [];
		return arr.map((r) => ({
			toolName: typeof r.toolName === "string" ? r.toolName : "",
			isError: Boolean(r.isError),
			textLength: typeof r.textLength === "number" ? r.textLength : 0,
		}));
	} catch {
		return [];
	}
}

/** Build the ordered list of turn pairs for a session. */
export function buildTurnPairs(messages: MessageRow[]): TurnPair[] {
	const pairs: TurnPair[] = [];
	let current: TurnPair | null = null;
	let priorUserText: string | null = null;

	const flush = (): void => {
		if (current) {
			pairs.push(current);
			priorUserText = current.userText;
			current = null;
		}
	};

	for (const m of messages) {
		if (m.role === "user") {
			flush();
			current = {
				index: pairs.length,
				userMessageId: m.id,
				messageIds: [m.id],
				userText: m.content_text ?? "",
				assistantText: "",
				thinkingText: "",
				toolCalls: [],
				toolResults: [],
				priorUserText,
				timestamp: m.timestamp,
			};
			continue;
		}

		if (!current) continue; // pre-first-user noise (e.g. summaries)

		if (m.role === "assistant") {
			current.messageIds.push(m.id);
			if (m.content_text) current.assistantText += (current.assistantText ? "\n" : "") + m.content_text;
			if (m.content_thinking) current.thinkingText += (current.thinkingText ? "\n" : "") + m.content_thinking;
			current.toolCalls.push(...parseToolCalls(m.tool_calls));
		} else if (m.role === "toolResult") {
			current.messageIds.push(m.id);
			current.toolResults.push(...parseToolResults(m.tool_results));
		}
	}

	flush();
	return pairs;
}
