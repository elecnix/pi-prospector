/**
 * Type definitions for pi-prospector.
 * All data shapes are plain TypeScript interfaces — no TypeBox schemas needed
 * for internal types. TypeBox schemas are used only for the Pi tool registration
 * where Pi's API expects them.
 */

// ─── Config ───

export interface ProspectorConfig {
	model?: string; // provider/model format, e.g. "openrouter/deepseek-v4-flash"
	dbPath?: string; // defaults to ~/.pi/agent/prospector.db
}

// ─── Session ───

export interface SessionHeader {
	id: string;
	version: number;
	timestamp?: string;
	cwd?: string;
	parentSession?: string;
}

// ─── Messages ───

export type MessageRole =
	| "user"
	| "assistant"
	| "toolResult"
	| "bashExecution"
	| "custom"
	| "branchSummary"
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
}

export interface SyncCursor {
	session_id: string;
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

export type ProposalSeverity = "friction" | "correction" | "waste" | "suggestion";
export type ProposalStatus = "new" | "accepted" | "rejected";

export interface NewProposal {
	sessionId: string;
	target: string;
	severity: ProposalSeverity;
	summary: string;
	detail: string;
	evidence: string;
	dedupHash: string;
}

export interface Proposal {
	id: string;
	created_at: string;
	session_id: string;
	target: string;
	severity: ProposalSeverity;
	summary: string;
	detail: string;
	evidence: string;
	status: ProposalStatus;
	dedup_hash: string;
}

// ─── Stats ───

export interface Stats {
	totalSessions: number;
	totalMessages: number;
	totalToolResults: number;
	messagesProcessed: number;
	proposalsByStatus: Record<ProposalStatus, number>;
}

// ─── Analyze ───

export interface AnalyzeResult {
	sessionsAnalyzed: number;
	proposalsGenerated: number;
	errors: string[];
}

// ── Analyzer Framework Types ──

export type AnchorSpan = "pair" | "segment" | "full_session";
export type ImplementationKind = "deterministic" | "in_process_llm" | "pi_subagent";
export type NodeKind = "metric" | "classification" | "summary" | "proposal" | "error";
export type EdgeKind = "anchors" | "consumes" | "refines" | "uses_prompt" | "uses_config" | "produces";
export type RunStatus = "planned" | "running" | "ok" | "error" | "partial";
export type ProgressStatus = "ok" | "in_progress" | "error" | "needs_rerun";
export type ProposalStatusLong = "open" | "accepted" | "applied" | "rejected" | "duplicate";
export type ProposalSeverityLong = "friction" | "correction" | "waste" | "suggestion" | "insight";
export type TargetType = "agents_md" | "system_md" | "skill" | "extension_prompt" | "tool_output" | "repo_doc" | "config";

export interface AnalyzerDef {
	id: string;
	label: string;
	description?: string;
	anchorSpan: AnchorSpan;
	dependencies: string[];
	createdAt: string;
}

export interface AnalyzerVersion {
	analyzerId: string;
	versionId: string;
	implementationKind: ImplementationKind;
	codeRef?: string;
	createdAt: string;
}

export interface PromptVersion {
	hash: string;
	fullHash: string;
	content: string;
	role?: "classify" | "map" | "reduce" | "verify";
	createdAt: string;
}

export interface AnalyzerConfig {
	id: string;
	analyzerId: string;
	configJson: Record<string, unknown>;
	configHash: string;
	label?: string;
	createdAt: string;
}

// ── Source Types ──

export interface SourceRef {
	kind: "message" | "analysis_node" | "session";
	id: string;
}

// ── Analysis Units ──

export interface AnalysisUnit {
	sources: SourceRef[];
	sourceSetHash: string;
	anchorKind: "message" | "pair" | "segment" | "session" | "analysis_node" | "none";
	anchorRef?: string;
	meta?: Record<string, unknown>;
}

// ── Analysis Results ──

export interface AnalysisEdge {
	toRefKind: SourceRef["kind"] | "prompt_version" | "config_version";
	toRefId: string;
	edgeKind: EdgeKind;
	ordinal?: number;
}

export interface AnalysisResult {
	contentJson: Record<string, unknown>;
	nodeKind: NodeKind;
	anchorKind: "message" | "pair" | "segment" | "session" | "analysis_node" | "none";
	anchorRef?: string;
	edges: AnalysisEdge[];
	modelUsed?: string;
	costUsd?: number;
	tokensUsed?: number;
	durationMs?: number;
}

// ── Context Types ──

export interface AnalyzerPlanContext {
	sessionId: string;
	messages: AnalysisMessage[];
	allNodes: AnalysisNodeRow[];
	ownNodes: AnalysisNodeRow[];
	dependencyNodes: Record<string, AnalysisNodeRow[]>;
	progress: ProgressRow | null;
	db: unknown; // Database type - using unknown to avoid circular imports
}

export interface AnalyzerRunContext {
	getMessage(id: string): AnalysisMessage | undefined;
	getNode(id: string): AnalysisNodeRow | undefined;
	getDependencyNodes(analyzerId: string): AnalysisNodeRow[];
	llm(request: LLMRequest): Promise<LLMResponse>;
	run: RunRow;
	config: AnalyzerConfig;
	prompts: Record<string, string>;
}

// ── LLM Types ──

export interface LLMRequest {
	messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
	model?: string;
	json?: boolean;
	maxTokens?: number;
	temperature?: number;
}

export interface LLMResponse {
	content: string;
	json?: Record<string, unknown>;
	model: string;
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
	};
	costUsd?: number;
}

// ── Database Row Types ──

export interface AnalyzerDefRow {
	id: string;
	label: string;
	description: string | null;
	anchor_span: string;
	dependencies: string;
	created_at: string;
}

export interface AnalyzerVersionRow {
	analyzer_id: string;
	version_id: string;
	implementation_kind: string;
	code_ref: string | null;
	created_at: string;
}

export interface PromptRegistryRow {
	hash: string;
	content: string;
	role: string | null;
	full_hash: string;
	created_at: string;
}

export interface AnalyzerConfigRow {
	id: string;
	analyzer_id: string;
	config_hash: string;
	config_json: string;
	label: string | null;
	created_at: string;
}

export interface RunRow {
	id: string;
	analyzer_id: string;
	analyzer_version_id: string;
	config_id: string;
	session_id: string;
	status: RunStatus;
	prompt_bundle_hash: string;
	started_at: string;
	finished_at: string | null;
	model_spec: string | null;
	cost_usd: number;
	tokens_used: number;
	nodes_produced: number;
	nodes_skipped: number;
	error_message: string | null;
}

export interface AnalysisNodeRow {
	id: string;
	session_id: string;
	analyzer_id: string;
	analyzer_version_id: string;
	config_id: string;
	run_id: string;
	node_kind: string;
	content_json: string;
	source_set_hash: string;
	input_hash: string;
	created_at: string;
	model_used: string | null;
	cost_usd: number;
	tokens_used: number;
	duration_ms: number | null;
}

export interface AnalysisEdgeRow {
	from_node_id: string;
	to_ref_kind: string;
	to_ref_id: string;
	edge_kind: string;
	ordinal: number;
}

export interface ProgressRow {
	analyzer_id: string;
	analyzer_version_id: string;
	config_id: string;
	session_id: string;
	cursor_json: string | null;
	last_run_id: string | null;
	total_analyzed: number;
	status: ProgressStatus;
	error_message: string | null;
	updated_at: string;
}

export interface ProposalRow {
	id: string;
	analysis_node_id: string;
	session_id: string;
	analyzer_id: string;
	target_type: string;
	target_path: string | null;
	title: string;
	summary: string;
	detail: string | null;
	evidence_json: string | null;
	confidence: number | null;
	severity: string;
	dedup_key: string;
	status: ProposalStatusLong;
	created_at: string;
	updated_at: string;
}

// ── Analysis Message Type ──

export interface AnalysisMessage {
	id: string;
	session_id: string;
	parent_id: string | null;
	timestamp: string | null;
	role: string;
	content_text: string | null;
	content_thinking: string | null;
	tool_calls: string | null;
	tool_results: string | null;
}

// ── Analyzer Interface ──

export interface Analyzer {
	def: AnalyzerDef;
	version: AnalyzerVersion;
	prompts: Record<string, PromptVersion>;
	defaultConfig: AnalyzerConfig;
	plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> | AnalysisUnit[];
	analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> | AnalysisResult;
}