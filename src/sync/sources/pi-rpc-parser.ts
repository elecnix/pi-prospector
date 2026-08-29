/**
 * pi-rpc frame parsing — map an RPC event-stream transcript onto message rows.
 *
 * A pi-rpc `out.jsonl` is not a session log: it is the RPC/UI event stream of a
 * headless Pi session (one directory per agent under `~/.pi/agent/sessions/pi-rpc/`).
 * It opens with an `extension_ui_request` rather than a `{"type":"session"}`
 * header, so the ordinary Pi parser rejects it with "No session header" and
 * every such transcript has been invisible to the corpus (#263).
 *
 * The stream mixes transport (widget/status/response frames — 15M of them per
 * corpus scan) with real conversation. Only **complete** messages are mapped:
 * a `message_end` frame carries the full Message with role, content parts,
 * usage, model and stop reason. `message_start`/`message_update` are streaming
 * intermediates for the same message and must not become rows; everything else
 * is lifecycle or transport and is dropped.
 *
 * One nuance: `custom` messages (extension notifications — subagent events,
 * monitor ticks, intercom messages) are mapped but their role is preserved
 * verbatim rather than coerced. They are part of what happened in the session
 * — a subagent completion explains what the agent did next — but they are not
 * user/assistant turns, and relabelling them would lie about the turn
 * structure. Consumers that filter on the canonical roles simply exclude them,
 * exactly as they already exclude bashExecution and branch_summary rows.
 */
import type { MessageInsert } from "../../db/queries.js";
import type { MessageRole } from "../../types.js";
import { classifySubagentResult } from "../parser.js";

/** A frame's parse context: the owning directory name and its line number. */
export interface RpcFrameContext {
	/** The pi-rpc directory name — the human-facing session identity. */
	dirName: string;
	/** 1-based line number in the transcript; part of the message identity. */
	lineNo: number;
}

const TRANSPORT_PREFIXES = ["extension_ui_request", "response", "message_update", "message_start"] as const;

/**
 * Custom-message roles that are pure extension plumbing — events about the
 * harness's own bookkeeping, with no conversational content. These become no
 * rows: they carry no turn, no tool call, and no user-visible outcome. The
 * subagent/intercom/monitor types that record what the fleet actually did are
 * kept (role `custom`), because a subagent completion is part of the session's
 * story.
 */
const NOISE_CUSTOM_TYPES = new Set(["job-finished", "bg-monitor-event", "task-notification"]);

/**
 * Parse one transcript line into a message row, or null when the frame is
 * transport, lifecycle noise, or unusable.
 *
 * Message identity is `pi-rpc:<dir>:L<line>` — deterministic and stable across
 * re-syncs because the transcript file is append-only and the directory name is
 * the durable key. The stream itself carries no per-frame message id to use
 * instead.
 */
export function parseRpcFrame(line: string, ctx: RpcFrameContext): MessageInsert | null {
	const trimmed = line.trim();
	if (!trimmed) return null;

	// Cheap prefix reject before JSON.parse: transport frames dominate the stream
	// (~20:1 over message frames), and skipping them without parsing keeps ingest
	// of a multi-GB corpus tractable.
	for (const p of TRANSPORT_PREFIXES) {
		if (trimmed.startsWith(`{"type":"${p}"`)) return null;
	}

	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(trimmed) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (obj.type !== "message_end") return null;

	const msg = obj.message as Record<string, unknown> | undefined;
	if (!msg || typeof msg !== "object") return null;

	const role = (msg.role as string) ?? "unknown";
	const content = msg.content;

	let text: string | null = null;
	let thinking: string | null = null;
	type RpcToolCall = { id: string; name: string; arguments: Record<string, unknown> };
	let tool_calls: RpcToolCall[] | null = null;
	let tool_results: Array<{ toolCallId: string; toolName: string; isError: boolean; textLength: number; subagent?: ReturnType<typeof classifySubagentResult> }> | null = null;

	if (typeof content === "string") {
		text = content;
	} else if (Array.isArray(content)) {
		const textParts: string[] = [];
		const thinkParts: string[] = [];
		const calls: RpcToolCall[] = [];
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

	if (role === "custom" && NOISE_CUSTOM_TYPES.has(String(msg.customType))) return null;

	if (role === "toolResult") {
		const resultText = text ?? "";
		const toolName = String(msg.toolName ?? "");
		const result = {
			toolCallId: String(msg.toolCallId ?? ""),
			toolName,
			isError: Boolean(msg.isError),
			textLength: resultText.length,
		};
		// Same orchestration-outcome classification as the Pi parser, so delegated
		// work reads identically regardless of which transcript shape recorded it.
		const subagent = classifySubagentResult(toolName, text);
		tool_results = [subagent ? { ...result, subagent } : result];
		// A tool result's text is result payload, not conversation content.
		text = null;
	}

	const isAssistant = role === "assistant";
	const usageRaw = isAssistant ? (msg.usage as Record<string, unknown> | undefined) : undefined;
	const costTotal = usageRaw ? (usageRaw.cost as Record<string, unknown> | undefined)?.total : undefined;

	return {
		id: `pi-rpc:${ctx.dirName}:L${ctx.lineNo}`,
		session_id: `pi-rpc/${ctx.dirName}`,
		source: "pi-rpc",
		parent_id: null,
		timestamp: extractTimestamp(msg.timestamp),
		role: role as MessageRole,
		content_text: text,
		content_thinking: thinking,
		tool_calls: tool_calls ? JSON.stringify(tool_calls) : null,
		tool_results: tool_results ? JSON.stringify(tool_results) : null,
		usage: usageRaw ? JSON.stringify(usageRaw) : null,
		model: isAssistant && typeof msg.model === "string" && msg.model.length > 0 ? msg.model : null,
		cost_usd: typeof costTotal === "number" && Number.isFinite(costTotal) && costTotal > 0 ? costTotal : null,
		provider_message_id: null,
		stop_reason: isAssistant && typeof msg.stopReason === "string" && msg.stopReason.length > 0 ? msg.stopReason : null,
		error_message: isAssistant && typeof msg.errorMessage === "string" && msg.errorMessage.length > 0 ? msg.errorMessage : null,
	};
}

/** Epoch-milliseconds message timestamp → ISO, or null when absent/unusable. */
function extractTimestamp(raw: unknown): string | null {
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
	return new Date(raw).toISOString();
}
