/**
 * Type definitions for pi-prospector.
 * All data shapes are plain TypeScript interfaces — no TypeBox schemas needed
 * for internal types. TypeBox schemas are used only for the Pi tool registration
 * where Pi's API expects them.
 */

// ─── Config ───

export interface ProspectorConfig {
	model?: string; // provider/model format, e.g. "anthropic/claude-sonnet-4-5"
	dbPath?: string; // defaults to ~/.pi/agent/prospector.db
	/** Model tiers used by analyzers (cheap/mid/expensive → provider/model). */
	modelTiers?: {
		cheap: string;
		mid: string;
		expensive: string;
	};
}

// ─── Session ───

export type SessionSource = "pi" | "claude";

export interface SessionHeader {
	id: string;
	version: number;
	timestamp?: string;
	cwd?: string;
	parentSession?: string;
}

// ─── Claude-specific types ───

export interface ClaudeSessionMeta {
	title: string | null;
	timestamp: string | null;
	cwd: string | null;
}

// ─── Messages ───

export type MessageRole =
	| "user"
	| "assistant"
	| "toolResult"
	| "bashExecution"
	| "custom_message"
	| "branch_summary"
	| "compactionSummary";

export interface ToolCallInfo {
	name: string;
	arguments: Record<string, unknown>;
}

export interface ToolResultInfo {
	toolCallId: string;
	toolName: string;
	isError: boolean;
	textLength: number;
}

export interface MessageEntry {
	id: string;
	parentId: string | null;
	timestamp: string | null;
	role: MessageRole;
	contentText: string | null;
	contentThinking: string | null;
	toolCalls: ToolCallInfo[] | null;
	toolResults: ToolResultInfo[] | null;
}

export interface ParsedLine {
	type: "session" | "message";
	data: SessionHeader | MessageEntry;
}

// ─── Sync ───

export interface DiscoveredSession {
	filePath: string;
	project: string;
	mtime: number; // milliseconds
	size: number;
	source: SessionSource;
}

export interface SyncCursor {
	last_line: number;
	last_modified: number;
}

export interface ForkInfo {
	parentSessionId: string;
	parentFilePath: string;
	branchLine: number; // line number where the fork diverges
}

export interface SyncResult {
	sessionsProcessed: number;
	sessionsSkipped: number;
	messagesInserted: number;
	forksResolved: number;
	errors: string[];
}

// ─── Proposals ───

export type ProposalSeverity = "friction" | "correction" | "waste" | "suggestion" | "reinforcement";
export type ProposalStatus = "open" | "applied" | "rejected" | "duplicate";

export interface Proposal {
	id: string;
	created_at: string;
	updated_at: string;
	session_id: string;
	source_node_id: string | null;
	analyzer_id: string | null;
	target_type: string;
	target_path: string | null;
	title: string;
	severity: string;
	summary: string;
	detail: string | null;
	evidence: string | null;
	confidence: number | null;
	status: ProposalStatus;
	input_key: string;
	/** JSON array (text) of the originating high-signal user-message ids; null until set. */
	source_message_ids: string | null;
	/** Grounded replay score in [0,1]; null until validated (issue #6). */
	validated_score: number | null;
	/** unvalidated | supported | unsupported. */
	validation_status: string;
	/** The validation node that produced the grounded score, if any. */
	validation_node_id: string | null;
}

// ─── Decisions (append-only human feedback) ───

/** What the human decided about a proposal. */
export type DecisionVerdict = "accepted" | "rejected" | "accepted_modified";

/**
 * How the human acted on an accepted proposal:
 *   planned          — "I will do it" (intent recorded, not yet done)
 *   done             — "I did the recommended action"
 *   done_differently — "the idea triggered a different action than recommended"
 */
export type DecisionDisposition = "planned" | "done" | "done_differently";

/**
 * An append-only record of a human accept/reject. Keyed by the proposal's
 * content-addressed `proposal_input_key` (not a row id) so it survives a wipe +
 * recompute. The latest row by `decided_at` is authoritative.
 */
export interface ProposalDecision {
	id: string;
	proposal_input_key: string;
	decision: DecisionVerdict;
	disposition: DecisionDisposition | null;
	rationale: string | null;
	actual_change: string | null;
	harness_ref: string | null;
	decided_at: string;
}

// ─── Stats ───

export interface Stats {
	totalSessions: number;
	piSessions: number;
	claudeSessions: number;
	totalMessages: number;
	piMessages: number;
	claudeMessages: number;
	totalToolResults: number;
	sessionsAnalyzed: number;
	proposalsByStatus: Record<ProposalStatus, number>;
	analysis: {
		nodes: number;
		edges: number;
		runs: number;
		nodesByKind: Record<string, number>;
	};
}

// ─── Analyze ───

export interface AnalyzeResult {
	sessionsAnalyzed: number;
	proposalsGenerated: number;
	errors: string[];
}