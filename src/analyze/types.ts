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
	Type.Literal("validation"),
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
	/**
	 * What kind of thing this input is. Most sources are conversation entities or
	 * upstream nodes. `term` is the *corpus-scoped* kind: its id is a normalised
	 * word rather than a row, so a unit keyed on a term has the same identity in
	 * every session. Combined with the table-wide uniqueness of `input_key`, that
	 * makes the analysis graph itself the corpus-wide cache for per-word analysis —
	 * the first session to nominate a word pays for it, every later session finds
	 * the work already `current`.
	 */
	kind: Type.Union([
		Type.Literal("message"),
		Type.Literal("analysis_node"),
		Type.Literal("session"),
		Type.Literal("term"),
	]),
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
	/** Non-cached input tokens billed for this node's LLM inference. Undefined for deterministic nodes. */
	inputTokens: Type.Optional(Type.Number()),
	/** Cached input tokens (cache read + cache write) billed for this node's LLM inference. */
	cachedInputTokens: Type.Optional(Type.Number()),
	/** Output tokens billed for this node's LLM inference. */
	outputTokens: Type.Optional(Type.Number()),
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
	/** The serving model that produced this assistant message, or null when unrecorded. */
	model: Type.Union([Type.String(), Type.Null()]),
	/** The billed dollar cost of this assistant message, or null when unrecorded. */
	cost_usd: Type.Union([Type.Number(), Type.Null()]),
	/** How the assistant generation ended, verbatim from the host, or null. */
	stop_reason: Type.Union([Type.String(), Type.Null()]),
	/** Why the generation failed, verbatim from the host, or null when it did not. */
	error_message: Type.Union([Type.String(), Type.Null()]),
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
	input_tokens: Type.Union([Type.Number(), Type.Null()]),
	cached_input_tokens: Type.Union([Type.Number(), Type.Null()]),
	output_tokens: Type.Union([Type.Number(), Type.Null()]),
	duration_ms: Type.Union([Type.Number(), Type.Null()]),
	created_at: Type.String(),
	/** Retraction tombstone: NULL = live; an ISO instant hides it from live reads. */
	retracted_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	/** Provenance of the retraction (the gc operation id). */
	retracted_by_run: Type.Optional(Type.Union([Type.String(), Type.Null()])),
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
	/**
	 * How much the model should think before answering.
	 *
	 * This belongs to the *analyzer*, not to the run: judging a single lexicon
	 * word needs none, while a session synthesis may want plenty, and both happen
	 * in the same run. Reasoning tokens are billed as output, so "off" on a
	 * high-volume trivial task is a direct saving as well as a latency one.
	 * Providers that cannot vary it ignore the field.
	 */
	reasoning: Type.Optional(
		Type.Union([
			Type.Literal("off"),
			Type.Literal("minimal"),
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
		]),
	),
	/**
	 * Request structured output via a forced tool call. When set, the caller
	 * offers this single tool to the model and returns its parsed call arguments
	 * in `LLMResponse.structured`. `parameters` is a TypeBox schema (TSchema).
	 * Far more reliable than "return only JSON" for reasoning models.
	 *
	 * Mutually exclusive with `responseSchema`.
	 */
	tool: Type.Optional(
		Type.Object({
			name: Type.String(),
			description: Type.String(),
			parameters: Type.Unknown(),
		}),
	),
	/**
	 * Request provider-enforced structured output via `response_format`.
	 * When set, the provider guarantees the response is valid JSON conforming
	 * to `schema` — the model cannot skip it, return empty text, or produce
	 * malformed JSON. The parsed object is returned in `LLMResponse.structured`.
	 *
	 * `schema` must be a strict-compatible JSON Schema: every property required,
	 * `additionalProperties: false` at every object level. The caller is
	 * responsible for this; the framework does not rewrite the schema.
	 *
	 * For OpenRouter, `require_parameters: true` is sent in provider routing
	 * so only endpoints that support structured outputs are selected.
	 *
	 * Mutually exclusive with `tool`.
	 */
	responseSchema: Type.Optional(
		Type.Object({
			name: Type.String(),
			schema: Type.Unknown(),
			strict: Type.Optional(Type.Boolean()),
		}),
	),
});
export type LLMRequest = Static<typeof LLMRequest>;

export const LLMResponse = Type.Object({
	text: Type.String(),
	thinking: Type.Optional(Type.String()),
	/** Parsed arguments of the forced tool call, when `request.tool` was set and the model called it. */
	structured: Type.Optional(Type.Unknown()),
	model: Type.String(),
	costUsd: Type.Number(),
	tokensUsed: Type.Number(),
	/** Input (non-cached) tokens billed for the call, when the provider reports them. */
	inputTokens: Type.Optional(Type.Number()),
	/** Cached input tokens (cache read + cache write) for the call, when reported. */
	cachedInputTokens: Type.Optional(Type.Number()),
	/** Output tokens billed for the call, when the provider reports them. */
	outputTokens: Type.Optional(Type.Number()),
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
	/**
	 * A declared dependency's newest node per logical unit, across *every* session.
	 *
	 * For corpus-wide subjects — a lexicon term belongs to the corpus, not to the
	 * session that first surfaced it — the session-scoped `dependencyNodes` is not
	 * enough. Dependency-scoped visibility still holds: this throws for an
	 * undeclared dependency exactly like `getDependencyNodes`. Only the session
	 * scope is lifted, and the read is lazy, so analyzers that do not need it pay
	 * nothing.
	 */
	getGlobalDependencyNodes: (analyzerId: string) => AnalysisNodeRow[];
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
	/**
	 * A declared dependency's newest node per logical unit, across every session —
	 * the corpus-scoped read. See {@link AnalyzerPlanContext.getGlobalDependencyNodes}.
	 */
	getGlobalDependencyNodes: (analyzerId: string) => AnalysisNodeRow[];
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
	/**
	 * Content hash of a disk-loaded analyzer's source (module text + prompt
	 * contents). Set by the loader for custom analyzers and folded into the config
	 * fingerprint, so editing the file marks prior nodes `stale` without a manual
	 * version bump — the authoring loop. Built-in analyzers leave this undefined;
	 * their identity is governed solely by the author-graded version.
	 */
	contentHash?: string;
	/** Absolute path a disk-loaded analyzer was loaded from (diagnostics only). */
	sourcePath?: string;
	/**
	 * The subject kinds whose ACTIVE assertions fold into this analyzer's config
	 * fingerprint, so muting one of them marks this analyzer's nodes stale for the
	 * `config` reason (a plain fill leaves them alone, `--revise config` recomputes
	 * them, old nodes stay as lineage). Only analyzers that actually consult the
	 * mute list set this — `turn-frustration` consults term mutes, while
	 * `frustration-lexicon` (which judges, not matches) deliberately does not.
	 * The mute set is `config` (DESIGN.md: config is what the user sets); folding
	 * it into the fingerprint makes muting behave exactly like changing a threshold.
	 */
	consultsAssertions?: readonly string[];
	/**
	 * Facts about the machine's setup that this analyzer reads, reduced to stable
	 * strings and folded into its config fingerprint.
	 *
	 * Some analyzers consult state that is neither their own parameters nor the
	 * graph: what the host has installed, for instance. That state is `config` by
	 * DESIGN.md's definition — the user set it — so changing it must mark the
	 * affected nodes stale for the `config` reason rather than leaving a
	 * conclusion standing that was drawn under a setup that no longer exists.
	 * This is the general form of what `contentHash` and `consultsAssertions`
	 * already do for two specific cases.
	 *
	 * Called during scan, so it must be cheap and must never throw: an
	 * unreadable source of truth is a fact about the environment, and the
	 * analyzer states it on the node instead of failing the run.
	 */
	identityExtras?: () => readonly string[];
	/**
	 * Files this analyzer can render from the finished graph.
	 *
	 * An analyzer's `analyze()` produces *nodes* — the durable, content-addressed
	 * record. An output produces a *file*: the same findings shaped for a person,
	 * or for a tool that is not this one. Keeping them apart matters, because they
	 * have opposite lifecycles. A node is immutable and expensive; an output is
	 * disposable and cheap, re-rendered from scratch on every request. Nothing is
	 * written to the graph when an output runs, so re-rendering can never revise
	 * history, and an output that crashes costs a re-run rather than a repair.
	 *
	 * Optional: an analyzer with no outputs is unaffected.
	 */
	outputs?: readonly AnalyzerOutput[];
}

// ─────────────────────────── outputs ───────────────────────────

/** One rendered file. `content` is text; binary outputs are out of scope. */
export const OutputArtifact = Type.Object({
	/** Bare file name, no directory — the caller chooses where it lands. */
	filename: Type.String(),
	mediaType: Type.String(),
	content: Type.String(),
	/** One line telling a reader what they are looking at. */
	summary: Type.Optional(Type.String()),
});
export type OutputArtifact = Static<typeof OutputArtifact>;

export const AnalyzerOutputDef = Type.Object({
	/** Unique within its analyzer. Addressed as `<analyzer-id>:<output-id>`. */
	id: Type.String(),
	label: Type.String(),
	description: Type.String(),
});
export type AnalyzerOutputDef = Static<typeof AnalyzerOutputDef>;

/**
 * Context handed to an output's `render()`.
 *
 * Unlike `plan()`/`analyze()`, this reads across the whole corpus and across
 * analyzers: `getNodes` will return any analyzer's nodes without that analyzer
 * being a declared dependency. That looks like a hole in the dependency rule and
 * is not one. The rule exists so a node's *identity* names every input that
 * shaped it — an output has no identity, writes nothing, and can neither create
 * a cycle nor make anything stale. A report that needs two analyzers' findings
 * is the ordinary case, and forcing a dependency edge to express it would
 * reorder real analysis work to satisfy a rendering concern.
 */
export interface AnalyzerOutputContext {
	db: Database.Database;
	/**
	 * Newest live node per logical unit for the owning analyzer, corpus-wide.
	 * Read lazily — an output that never touches it runs no query.
	 *
	 * "Per logical unit" is not "per session": an analyzer that folds a session's
	 * progress into its `sourceSetHash` has one live node per generation of that
	 * session, and summing them counts the session twice. `latestBySession` is the
	 * fold for that.
	 */
	readonly ownNodes: AnalysisNodeRow[];
	/** The same read for any analyzer id. Empty when that analyzer has never run. */
	getNodes: (analyzerId: string) => AnalysisNodeRow[];
	/** The owning analyzer's resolved config. */
	config: Record<string, unknown>;
	/** Caller-supplied knobs, e.g. `{ day: "2026-08-14" }`. */
	options: Record<string, string>;
	/** When set, the graph is read as it stood at this instant. */
	asOf?: string;
}

/** A named file an analyzer knows how to render. */
export interface AnalyzerOutput {
	def: AnalyzerOutputDef;
	render: (ctx: AnalyzerOutputContext) => OutputArtifact[] | Promise<OutputArtifact[]>;
}

// ─────────────────────────── framework results ───────────────────────────

export interface ClassifiedUnit {
	analyzerId: string;
	unit: AnalysisUnit;
	status: UnitStatus;
	inputKey: string;
	/** For `stale` units: the prior node this unit would revise. */
	priorNodeId?: string;
	/** For `stale` units: the prior node's content-addressed output_key (the `revises` edge target). */
	priorOutputKey?: string;
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
