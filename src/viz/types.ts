/**
 * Shapes for the interactive HTML session visualization (`prospect viz`).
 *
 * The visualization is an **output**, not an analysis step: it reads the graph,
 * embeds what it read as JSON inside one self-contained HTML file, and writes
 * nothing back — no node, no run, no proposal. That is why these are plain view
 * schemas: they describe what a *reader* needs, never what identity folds in.
 *
 * Every entity here keeps its graph address (`input_key`, `output_key`, edge
 * id) so a reader can cross-check the page against `prospect nodes`, `show`,
 * or SQL and see the same thing.
 */

import { Type, type Static } from "typebox";

// ───────────────────────── command options ─────────────────────────

/**
 * The viz command's own knobs. `<session-id>` picks the session; when absent
 * the command renders a session picker instead of a page.
 */
export const VizArgsSchema = Type.Object({
	/** The session to render; empty string = show the picker. */
	sessionId: Type.String(),
	/** Directory the artifact lands in. Empty = caller's Documents folder. */
	outDir: Type.String(),
});

export type VizArgs = Static<typeof VizArgsSchema>;

// ───────────────────────── embedded data model ─────────────────────────

/** One transcript entry on the rail. Text stays verbatim up to a fixed cap. */
export const VizMessage = Type.Object({
	id: Type.String(),
	role: Type.String(),
	timestamp: Type.Union([Type.String(), Type.Null()]),
	text: Type.Union([Type.String(), Type.Null()]),
	thinking: Type.Union([Type.String(), Type.Null()]),
	toolCalls: Type.Union([Type.String(), Type.Null()]),
	/** A turn failure or tool error — rendered with an error mark on the rail. */
	isError: Type.Boolean(),
});

export const VizNode = Type.Object({
	id: Type.String(),
	analyzerId: Type.String(),
	analyzerVersionId: Type.String(),
	nodeKind: Type.String(),
	/** The parsed `content_json`. */
	content: Type.Unknown(),
	createdAt: Type.String(),
	/** Retraction tombstone: non-null marks a retracted (filterable) node. */
	retractedAt: Type.Union([Type.String(), Type.Null()]),
	inputKey: Type.String(),
	outputKey: Type.String(),
	modelUsed: Type.Union([Type.String(), Type.Null()]),
	costUsd: Type.Union([Type.Number(), Type.Null()]),
	tokensUsed: Type.Union([Type.Number(), Type.Null()]),
	/**
	 * Consumption depth from the session's roots (nodes that consume nothing):
	 * roots sit at 0, each consumer one past its deepest input. Drives the
	 * depth-collapse slider.
	 */
	depth: Type.Number(),
	/** Index into `lineageGroups`; null when the unit has exactly one version. */
	lineageGroup: Type.Union([Type.Number(), Type.Null()]),
});

export const VizEdge = Type.Object({
	id: Type.String(),
	fromNodeId: Type.String(),
	edgeKind: Type.String(),
	toRefKind: Type.String(),
	toRefId: Type.String(),
	ordinal: Type.Number(),
});

export const VizProposal = Type.Object({
	id: Type.String(),
	title: Type.String(),
	severity: Type.String(),
	status: Type.String(),
	summary: Type.String(),
	detail: Type.Union([Type.String(), Type.Null()]),
	evidence: Type.Union([Type.String(), Type.Null()]),
	confidence: Type.Union([Type.Number(), Type.Null()]),
	validatedScore: Type.Union([Type.Number(), Type.Null()]),
	validationStatus: Type.String(),
	sourceNodeId: Type.Union([Type.String(), Type.Null()]),
	targetType: Type.String(),
	targetPath: Type.Union([Type.String(), Type.Null()]),
	inputKey: Type.String(),
	/** User-message ids the summary attached as originating evidence. */
	sourceMessageIds: Type.Array(Type.String()),
	/**
	 * The click-through trail: source node → consumed nodes → anchored messages,
	 * resolved through the edge table so highlighting follows provenance.
	 */
	evidenceNodes: Type.Array(Type.String()),
	evidenceMessages: Type.Array(Type.String()),
});

/** One human verdict on a proposal (a decision assertion), keyed by input key. */
export const VizDecision = Type.Object({
	proposalInputKey: Type.String(),
	verdict: Type.String(),
	disposition: Type.Union([Type.String(), Type.Null()]),
	actualChange: Type.Union([Type.String(), Type.Null()]),
	reason: Type.Union([Type.String(), Type.Null()]),
	assertedAt: Type.String(),
	remediationId: Type.Union([Type.String(), Type.Null()]),
});

/** A shared remediation: external human input grouping N accepted decisions. */
export const VizRemediation = Type.Object({
	id: Type.String(),
	description: Type.Union([Type.String(), Type.Null()]),
	assertedAt: Type.Union([Type.String(), Type.Null()]),
	/** Proposal input keys of decisions made under this remediation. */
	decisionInputKeys: Type.Array(Type.String()),
});

/** An operator assertion reachable by a `mutes` edge (or shown beside it). */
export const VizAssertion = Type.Object({
	id: Type.String(),
	subjectKind: Type.String(),
	subjectKey: Type.String(),
	verdict: Type.String(),
	reason: Type.Union([Type.String(), Type.Null()]),
});

export const VizPromptRow = Type.Object({
	hash: Type.String(),
	content: Type.String(),
});

export const VizConfigRow = Type.Object({
	id: Type.String(),
	analyzerId: Type.String(),
	configJson: Type.String(),
});

/** One collapsible revises-chain: version alternatives ordered oldest first. */
export const VizLineageGroup = Type.Object({
	index: Type.Number(),
	nodeIds: Type.Array(Type.String()),
});

export const VizSessionMeta = Type.Object({
	id: Type.String(),
	name: Type.Union([Type.String(), Type.Null()]),
	source: Type.String(),
	project: Type.String(),
	cwd: Type.String(),
	startedAt: Type.Union([Type.String(), Type.Null()]),
	messageCount: Type.Number(),
});

/** Everything the page shows, embedded verbatim as JSON inside the HTML. */
export const VizDataSchema = Type.Object({
	version: Type.Literal(1),
	session: VizSessionMeta,
	messages: Type.Array(VizMessage),
	nodes: Type.Array(VizNode),
	edges: Type.Array(VizEdge),
	proposals: Type.Array(VizProposal),
	decisions: Type.Array(VizDecision),
	remediations: Type.Array(VizRemediation),
	assertions: Type.Array(VizAssertion),
	prompts: Type.Array(VizPromptRow),
	configs: Type.Array(VizConfigRow),
	lineageGroups: Type.Array(VizLineageGroup),
});

export type VizMessage = Static<typeof VizMessage>;
export type VizNode = Static<typeof VizNode>;
export type VizEdge = Static<typeof VizEdge>;
export type VizProposal = Static<typeof VizProposal>;
export type VizDecision = Static<typeof VizDecision>;
export type VizRemediation = Static<typeof VizRemediation>;
export type VizAssertion = Static<typeof VizAssertion>;
export type VizPromptRow = Static<typeof VizPromptRow>;
export type VizConfigRow = Static<typeof VizConfigRow>;
export type VizLineageGroup = Static<typeof VizLineageGroup>;
export type VizSessionMeta = Static<typeof VizSessionMeta>;
export type VizData = Static<typeof VizDataSchema>;

/** Per-message text cap on the rail. Long entries stay inspectable via SQL. */
export const MESSAGE_TEXT_CAP = 4000;
