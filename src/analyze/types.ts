/**
 * Analyzer framework type definitions.
 *
 * Per project guidelines, every *data shape* is a TypeBox schema with its
 * static type derived via `Static`. Behavioural contracts that carry function
 * members (analyzers and their execution contexts) are declared as interfaces,
 * since functions are not data shapes.
 */

import { Type, type Static } from "typebox";
import type Database from "better-sqlite3";

// ─────────────────────────── enumerations ───────────────────────────

export const ImplementationKind = Type.Union([
	Type.Literal("deterministic"),
	Type.Literal("in_process_llm"),
]);
export type ImplementationKind = Static<typeof ImplementationKind>;

export const AnchorSpan = Type.Union([
	Type.Literal("pair"),
	Type.Literal("segment"),
	Type.Literal("full_session"),
]);
export type AnchorSpan = Static<typeof AnchorSpan>;

export const NodeKind = Type.Union([
	Type.Literal("metric"),
	Type.Literal("classification"),
	Type.Literal("summary"),
	Type.Literal("proposal"),
	Type.Literal("error"),
]);
export type NodeKind = Static<typeof NodeKind>;

export const ReviseReason = Type.Union([
	Type.Literal("major"),
	Type.Literal("minor"),
	Type.Literal("config"),
]);
export type ReviseReason = Static<typeof ReviseReason>;

export const UnitStatus = Type.Union([
	Type.Literal("missing"),
	Type.Literal("stale"),
	Type.Literal("current"),
]);
export type UnitStatus = Static<typeof UnitStatus>;

export const RunStatus = Type.Union([
	Type.Literal("ok"),
	Type.Literal("error"),
	Type.Literal("partial"),
]);
export type RunStatus = Static<typeof RunStatus>;

// ─────────────────────────── registry shapes ───────────────────────────

export const AnalyzerDef = Type.Object({
	id: Type.String(),
	label: Type.String(),
	description: Type.String(),
	anchorSpan: AnchorSpan,
	dependencies: Type.Array(Type.String()),
});
export type AnalyzerDef = Static<typeof AnalyzerDef>;

export const AnalyzerVersion = Type.Object({
	analyzerId: Type.String(),
	/** Author-owned significance grade: bump major for significant changes, minor for small ones. */
	major: Type.Integer({ minimum: 0 }),
	minor: Type.Integer({ minimum: 0 }),
	implementationKind: ImplementationKind,
	codeRef: Type.Optional(Type.String()),
});
export type AnalyzerVersion = Static<typeof AnalyzerVersion>;

export const PromptVersion = Type.Object({
	hash: Type.String(),
	content: Type.String(),
	role: Type.Optional(Type.String()),
});
export type PromptVersion = Static<typeof PromptVersion>;

export const AnalyzerConfig = Type.Object({
	id: Type.String(),
	analyzerId: Type.String(),
	configHash: Type.String(),
	configJson: Type.Record(Type.String(), Type.Unknown()),
	label: Type.Optional(Type.String()),
});
export type AnalyzerConfig = Static<typeof AnalyzerConfig>;

// ─────────────────────────── planning shapes ───────────────────────────

export const SourceRef = Type.Object({
	kind: Type.Union([Type.Literal("message"), Type.Literal("analysis_node"), Type.Literal("session")]),
	id: Type.String(),
});
export type SourceRef = Static<typeof SourceRef>;

export const AnalysisUnit = Type.Object({
	sources: Type.Array(SourceRef),
	sourceSetHash: Type.String(),
	anchorKind: Type.Union([Type.Literal("session"), Type.Literal("message")]),
	anchorRef: Type.String(),
	meta: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type AnalysisUnit = Static<typeof AnalysisUnit>;

export const EdgeSpec = Type.Object({
	toRefKind: Type.String(),
	toRefId: Type.String(),
	edgeKind: Type.String(),
	ordinal: Type.Optional(Type.Number()),
});
export type EdgeSpec = Static<typeof EdgeSpec>;

export const AnalysisResult = Type.Object({
	nodeKind: NodeKind,
	contentJson: Type.Record(Type.String(), Type.Unknown()),
	anchorKind: Type.Union([Type.Literal("session"), Type.Literal("message")]),
	anchorRef: Type.String(),
	edges: Type.Array(EdgeSpec),
	modelUsed: Type.Optional(Type.String()),
	costUsd: Type.Optional(Type.Number()),
	tokensUsed: Type.Optional(Type.Number()),
	durationMs: Type.Optional(Type.Number()),
});
export type AnalysisResult = Static<typeof AnalysisResult>;

// ─────────────────────────── database rows ───────────────────────────

export const MessageRow = Type.Object({
	id: Type.String(),
	session_id: Type.String(),
	parent_id: Type.Union([Type.String(), Type.Null()]),
	timestamp: Type.Union([Type.String(), Type.Null()]),
	role: Type.String(),
	content_text: Type.Union([Type.String(), Type.Null()]),
	content_thinking: Type.Union([Type.String(), Type.Null()]),
	tool_calls: Type.Union([Type.String(), Type.Null()]),
	tool_results: Type.Union([Type.String(), Type.Null()]),
});
export type MessageRow = Static<typeof MessageRow>;

export const AnalysisNodeRow = Type.Object({
	id: Type.String(),
	session_id: Type.String(),
	analyzer_id: Type.String(),
	analyzer_version_id: Type.String(),
	config_id: Type.String(),
	run_id: Type.Union([Type.String(), Type.Null()]),
	node_kind: Type.String(),
	content_json: Type.String(),
	source_set_hash: Type.String(),
	input_key: Type.String(),
	output_key: Type.String(),
	config_fingerprint: Type.String(),
	model_used: Type.Union([Type.String(), Type.Null()]),
	cost_usd: Type.Union([Type.Number(), Type.Null()]),
	tokens_used: Type.Union([Type.Number(), Type.Null()]),
	duration_ms: Type.Union([Type.Number(), Type.Null()]),
	created_at: Type.String(),
});
export type AnalysisNodeRow = Static<typeof AnalysisNodeRow>;

export const AnalysisEdgeRow = Type.Object({
	id: Type.String(),
	from_node_id: Type.String(),
	to_ref_kind: Type.String(),
	to_ref_id: Type.String(),
	edge_kind: Type.String(),
	ordinal: Type.Number(),
});
export type AnalysisEdgeRow = Static<typeof AnalysisEdgeRow>;

export const AnalysisRunRow = Type.Object({
	id: Type.String(),
	analyzer_id: Type.String(),
	analyzer_version_id: Type.String(),
	config_id: Type.String(),
	session_id: Type.String(),
	mode: Type.String(),
	status: Type.String(),
	prompt_bundle_hash: Type.String(),
	model_spec: Type.Union([Type.String(), Type.Null()]),
	started_at: Type.String(),
	finished_at: Type.Union([Type.String(), Type.Null()]),
	nodes_produced: Type.Number(),
	nodes_skipped: Type.Number(),
	cost_usd: Type.Number(),
	tokens_used: Type.Number(),
	error_message: Type.Union([Type.String(), Type.Null()]),
});
export type AnalysisRunRow = Static<typeof AnalysisRunRow>;

// ─────────────────────────── LLM shapes ───────────────────────────

/**
 * A model tier configuration. Analyzers request a tier (cheap/mid/expensive);
 * the resolved provider/model strings come from `~/.pi/agent/prospector.json`.
 */
export const ModelTierConfig = Type.Object({
	cheap: Type.String(),
	mid: Type.String(),
	expensive: Type.String(),
});
export type ModelTierConfig = Static<typeof ModelTierConfig>;

export const ModelTier = Type.Union([
	Type.Literal("cheap"),
	Type.Literal("mid"),
	Type.Literal("expensive"),
]);
export type ModelTier = Static<typeof ModelTier>;

export const LLMRequest = Type.Object({
	/** A tier name ("cheap"|"mid"|"expensive") or an explicit "provider/model" spec. */
	model: Type.String(),
	system: Type.Optional(Type.String()),
	user: Type.String(),
	temperature: Type.Optional(Type.Number()),
	maxTokens: Type.Optional(Type.Number()),
});
export type LLMRequest = Static<typeof LLMRequest>;

export const LLMResponse = Type.Object({
	text: Type.String(),
	thinking: Type.Optional(Type.String()),
	model: Type.String(),
	costUsd: Type.Number(),
	tokensUsed: Type.Number(),
	durationMs: Type.Number(),
	stopReason: Type.String(),
});
export type LLMResponse = Static<typeof LLMResponse>;

/**
 * The LLM calling contract. Production wires this to Pi's AI provider system
 * (model registry + `@earendil-works/pi-ai` `complete`); tests wire a mock.
 * A function type, not a data shape.
 */
export type LLMCaller = (request: LLMRequest) => Promise<LLMResponse>;

// ─────────────────────────── behavioural contracts ───────────────────────────

/** Read-only context handed to `analyzer.plan()`. */
export interface AnalyzerPlanContext {
	sessionId: string;
	messages: MessageRow[];
	/** All analysis nodes for this session (own + dependencies). */
	allNodes: AnalysisNodeRow[];
	/** This analyzer's own nodes for the session. */
	ownNodes: AnalysisNodeRow[];
	/** Dependency nodes keyed by analyzer id (only declared dependencies). */
	dependencyNodes: Record<string, AnalysisNodeRow[]>;
	/** The resolved config JSON for this analyzer, so plan() can honour cost guards. */
	config: Record<string, unknown>;
	db: Database.Database;
}

/** Context handed to `analyzer.analyze()` while producing a single node. */
export interface AnalyzerRunContext {
	sessionId: string;
	getMessage: (id: string) => MessageRow | undefined;
	getNode: (id: string) => AnalysisNodeRow | undefined;
	/** Nodes from a declared dependency. Throws if the dependency was not declared. */
	getDependencyNodes: (analyzerId: string) => AnalysisNodeRow[];
	getSessionMessages: (sessionId: string) => MessageRow[];
	llm: LLMCaller;
	config: AnalyzerConfig;
	/** Prompt content keyed by prompt name. */
	prompts: Record<string, string>;
	modelTiers: ModelTierConfig;
}

/** An analyzer: stable definition + version + prompts + default config + behaviour. */
export interface Analyzer {
	def: AnalyzerDef;
	version: AnalyzerVersion;
	prompts: Record<string, PromptVersion>;
	defaultConfig: AnalyzerConfig;
	plan: (ctx: AnalyzerPlanContext) => AnalysisUnit[] | Promise<AnalysisUnit[]>;
	analyze: (unit: AnalysisUnit, ctx: AnalyzerRunContext) => AnalysisResult | Promise<AnalysisResult>;
	/**
	 * The concrete models this analyzer will use under the given config, with
	 * tier shorthands (cheap/mid/expensive) already resolved to `provider/model`.
	 * The resolved model is part of a node's `config` identity, so changing which
	 * model a tier resolves to marks existing nodes `stale` for the `config`
	 * reason — a run that includes `config` revises them into a new version, while
	 * a plain fill leaves them alone. Deterministic analyzers omit this: with no
	 * model, their identity never depends on model settings.
	 */
	modelsForIdentity?: (config: Record<string, unknown>, modelTiers: ModelTierConfig) => string[];
}

// ─────────────────────────── framework results ───────────────────────────

export interface ClassifiedUnit {
	analyzerId: string;
	unit: AnalysisUnit;
	status: UnitStatus;
	inputKey: string;
	/** For `stale` units: the prior node this unit would revise. */
	priorNodeId?: string;
	/** For `stale` units: why it is out of date (any of major/minor/config). Empty otherwise. */
	reasons: ReviseReason[];
}

export interface RunSummary {
	sessionId: string;
	/** The revise reasons this run acted on (empty = a plain fill of missing work). */
	revise: ReviseReason[];
	analyzerResults: AnalyzerRunResult[];
	nodesProduced: number;
	nodesSkipped: number;
	nodesRevised: number;
	proposalsCreated: number;
	costUsd: number;
	tokensUsed: number;
	errors: string[];
}

export interface AnalyzerRunResult {
	analyzerId: string;
	runId: string;
	nodesProduced: number;
	nodesSkipped: number;
	nodesRevised: number;
	costUsd: number;
	tokensUsed: number;
	status: RunStatus;
	errorMessage?: string;
}
