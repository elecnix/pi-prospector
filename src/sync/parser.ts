/**
 * JSONL line parser for Pi and Claude session files.
 */
import type { SessionHeader, MessageRole, ClaudeSessionMeta, SessionSource } from "../types.js";

export interface ParsedSession {
	kind: "session";
	header: SessionHeader;
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
		tool_calls: Array<{ name: string; arguments: Record<string, unknown> }> | null;
		tool_results: Array<{ toolCallId: string; toolName: string; isError: boolean; textLength: number }> | null;
	};
}

export type ParsedLine = ParsedSession | ParsedMessage;

export function parseLine(line: string, source?: SessionSource): ParsedLine | null {
	if (source === "claude") return parseClaudeLine(line);
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

		return {
			kind: "message",
			entry: { id, parentId, timestamp, role: role as MessageRole, text, thinking, tool_calls, tool_results },
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
			entry: { id, parentId, timestamp, role: role as MessageRole, text, thinking: null, tool_calls: null, tool_results: null },
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

/** Parse a line from a Claude Code JSONL session file. */
export function parseClaudeLine(line: string): ParsedLine | null {
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
					results.push({
						toolCallId: String(p.tool_use_id ?? ""),
						toolName: "",
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
			entry: { id: uuid, parentId: parentUuid, timestamp, role, text, thinking: null, tool_calls: null, tool_results },
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

		return {
			kind: "message",
			entry: { id: uuid, parentId: parentUuid, timestamp, role: "assistant", text, thinking, tool_calls, tool_results: null },
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