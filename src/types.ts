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
	/**
	 * Extra directories (or files) to load custom analyzers from, in addition to
	 * the always-scanned Pi agent path (~/.pi/agent/prospector/analyzers) and a
	 * project-local ./.prospector/analyzers. A leading ~ is expanded.
	 */
	analyzerPaths?: string[];
	/**
	 * Per-LLM-call timeout in milliseconds for an analyze run. A call that exceeds
	 * this is treated as stalled: it fails the unit, marks the session failed, and
	 * the run continues rather than hanging with no terminal state. Default 120000;
	 * also configurable via `PROSPECTOR_LLM_TIMEOUT_MS`.
	 */
	llmTimeoutMs?: number;
	/**
	 * Per-analyzer config overrides, keyed by analyzer id. Merged over the
	 * analyzer's shipped defaults.
	 *
	 * The tier→model mapping is global, but analyzers do not all warrant the same
	 * model. Judging a single lexicon term is about the simplest classification in
	 * the pipeline and runs hundreds of thousands of times, so it is the obvious
	 * place to spend a small local or free model, while per-turn classification
	 * keeps a stronger one. Without this, both share the `cheap` tier.
	 *
	 * Whatever is set here is part of the analyzer's config identity, so a change
	 * marks existing nodes stale for the `config` reason — picked up only by a run
	 * that asks for it, never silently.
	 *
	 * ```json
	 * { "analyzers": { "frustration-lexicon": { "tier": "ollama/gemma4:31b-mlx" } } }
	 * ```
	 */
	analyzers?: Record<string, Record<string, unknown>>;
	/**
	 * Session sources to enable beyond the built-in pi and claude file sources.
	 * Example: ["pi-subagent", "snowflake"]
	 *
	 * Built-in sources: "pi-subagent" (nested subagent sessions),
	 * "snowflake" (requires PROSPECTOR_SNOWFLAKE_SOURCE=1 + snow CLI).
	 * User-loaded sources from ~/.pi/agent/prospector/sources/<name>/
	 * or ./.prospector/sources/<name>/ are also resolved from this list.
	 */
	sources?: string[];
}

// ─── Session ───

export type SessionSource = string;

export interface SessionHeader {
	id: string;
	version: number;
	timestamp?: string;
	cwd?: string;
	parentSession?: string;
	/**
	 * The active tool manifest recorded at session start, if the host persists
	 * one (forward-compatible extension of the Pi session header; absent today).
	 * Absence means the inventory is UNKNOWN — analytics must never treat a
	 * missing manifest as "no tools available". Each entry may carry the
	 * character length of the tool's serialized definition (`definitionChars`),
	 * which is what makes the never-invoked tool priceable.
	 */
	tools?: Array<{ name: string; definitionChars?: number }>;
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

export interface UsageInfo {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	/**
	 * Billed dollar cost broken down per bucket, when the host reports it.
	 * (Pi's `usage.cost` sub-object.) NULL when the source carries no cost.
	 * Kept separate from token buckets so cache-economy can be priced in dollars.
	 */
	cost: CostInfo | null;
}

/** Billed dollar cost per usage bucket, as reported by the host. */
export interface CostInfo {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

/** One tool the session had available, with its definition's serialized size. */
export interface ToolInventoryEntry {
	name: string;
	/** Character length of the tool's serialized definition (the slice that sits
	 *  in the request prefix on every turn). NULL when the host supplied no size. */
	definitionChars: number | null;
}

/**
 * The set of tools a session had available, as distinct from the tool_calls it
 * actually invoked. This data is NOT backfillable: sessions recorded before the
 * host began persisting a manifest are UNKNOWN forever. Presence semantics are
 * therefore load-bearing and live in the storage, not a convention:
 *
 *   - never captured            -> sessions.tool_inventory IS NULL   (UNKNOWN)
 *   - captured, no tools        -> sessions.tool_inventory = '{"tools":[]}'
 *   - captured, tools available -> sessions.tool_inventory = populated
 *
 * A consumer must SKIP the UNKNOWN case; it must never read it as "no tools".
 */
export interface ToolInventory {
	/** Where the manifest came from (e.g. "pi-session-header"). */
	source: string;
	tools: ToolInventoryEntry[];
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
	usage: UsageInfo | null;
	/** The serving model that produced this assistant message, if recorded. */
	model: string | null;
	/** The billed dollar cost of this assistant message, or null when unrecorded. */
	costUsd: number | null;
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
	/** Child-run artifacts upserted (file mtime had moved past the stored one). */
	subagentRunsProcessed: number;
	/** Child-run artifacts already current — re-read only when their mtime moves. */
	subagentRunsSkipped: number;
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
	/** The billed dollar cost of the proposal's source turns; null when unpriced (issue #71). */
	cost_usd: number | null;
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
	/** Shared remediation this decision was made under, if accepted as part of a batch. */
	remediation_id: string | null;
	decided_at: string;
}

/**
 * One remediation action that addresses many proposals at once. Like decisions,
 * remediations are EXTERNAL human input (not analysis nodes) and survive a wipe
 * + recompute; decision rows link to it via `remediation_id`, so accepting N
 * proposals under one action records the shared context once instead of
 * duplicating the same rationale N times.
 */
export interface Remediation {
	id: string;
	description: string;
	actual_change: string | null;
	created_at: string;
}

// ─── Stats ───

export interface TokenStats {
	totalInput: number;
	totalOutput: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	totalTokens: number;
	turnCount: number;
	toolCallCount: number;
	/** Tokens per turn (0 if no turns) */
	inputPerTurn: number;
	outputPerTurn: number;
	cacheReadPerTurn: number;
	/** Tool calls per turn */
	toolCallsPerTurn: number;
}

export interface SourceTokenStats {
	combined: TokenStats;
	pi: TokenStats;
	claude: TokenStats;
	/** Pi-to-Claude ratio for each metric (null if Claude is 0) */
	ratios: {
		turns: number | null;
		toolCalls: number | null;
		input: number | null;
		output: number | null;
		cacheRead: number | null;
		cacheWrite: number | null;
		inputPerTurn: number | null;
		outputPerTurn: number | null;
		toolCallsPerTurn: number | null;
	};
}

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
		/** Non-retracted node count per analyzer_id */
		nodesByAnalyzer: Record<string, number>;
	};
	/** Per-source token and tool-call stats */
	tokens: SourceTokenStats;
}

// ─── Analyze ───

export interface AnalyzeResult {
	sessionsAnalyzed: number;
	proposalsGenerated: number;
	errors: string[];
}