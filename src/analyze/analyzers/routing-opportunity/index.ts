/**
 * routing-opportunity — a deterministic, turn-anchored analyzer that labels each
 * turn as downshiftable or escalation-worthy, *with the outcome in hand*.
 *
 * Motivation (chore, #69): routing — sending each request to the cheapest model
 * capable of answering it — must decide whether a request is hard *before*
 * seeing the answer. pi-prospector is uniquely positioned to judge that question
 * *after the fact*, with the outcome in hand. Turn-pair-core already classifies
 * corrections and tool failures, tool-trajectory already detects stuck-loops,
 * oscillations and pre-flight gaps, and turn-frustration already matches the
 * learned lexicon. This analyzer only groups those existing signals per turn and
 * adds the one field that makes them comparable across models — which model
 * served the turn, and what it cost.
 *
 * Two labels, which point in opposite directions — a router that only ever
 * downshifts is a router that loses money on retries:
 *
 *   - downshift  — the turn showed every marker of being easy (few tool calls,
 *                  small context, a bounded edit, little recorded deliberation,
 *                  no correction, no trajectory pathology). Running it on a
 *                  powerful model was probably waste.
 *   - escalate   — a correction or a trajectory pathology (stuck-loop /
 *                  oscillation / pre-flight gap) indicates the turn's model
 *                  failed and retried; the retries often cost more than one
 *                  capable turn would have.
 *   - neutral    — neither.
 *
 * The label is structural (model-independent). The model-price pairing — is an
 * easy turn actually running on an expensive model, and did a cheap model
 * actually produce the retries — happens in the corpus-level `model-mix`
 * analyzer, which folds in real cost per turn. Here we only attach the recorded
 * model and billed cost to the label, honestly.
 *
 * Coverage is explicit: a turn whose serving model was never recorded is
 * `model="unrecorded"`, distinct from a labelled-but-priced turn; cost is null
 * when no assistant step in the turn recorded a billed amount (money is never
 * invented).
 *
 * One `metric` node per turn; no LLM.
 */

import type {
	Analyzer,
	AnalyzerDef,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	AnalysisResult,
	AnalysisUnit,
	MessageRow,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeSourceSetHash, computeConfigHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { type TurnPair, type PairToolResult } from "../turn-pair-core/build.js";
import { TURN_PAIR_CORE_DEF } from "../turn-pair-core/index.js";
import { TURN_FRUSTRATION_DEF } from "../turn-frustration/index.js";
import { TOOL_TRAJECTORY_DEF, type ToolTrajectoryProperties } from "../tool-trajectory/index.js";
import { DEFAULT_ROUTING_CONFIG, type RoutingConfig } from "./config.js";
import { Type, type Static } from "typebox";

export const RoutingVerdict = Type.Union([
	Type.Literal("downshift"),
	Type.Literal("escalate"),
	Type.Literal("neutral"),
]);
export type RoutingVerdict = Static<typeof RoutingVerdict>;

export const RoutingProperties = Type.Object({
	user_message_id: Type.String(),
	pair_index: Type.Number(),
	/** The serving model of the turn's assistant steps, or "unrecorded" when none was recorded. */
	model: Type.String(),
	model_recorded: Type.Boolean(),
	/** Billed dollar cost of the turn's assistant steps, or null when none recorded. */
	turn_cost_usd: Type.Union([Type.Number(), Type.Null()]),
	features: Type.Object({
		tool_call_count: Type.Number(),
		/** Paragraphs in the turn's preserved reasoning, or null when none was recorded. */
		deliberation_paragraphs: Type.Union([Type.Number(), Type.Null()]),
		context_tokens: Type.Number(),
		edit_chars: Type.Number(),
		correction_detected: Type.Boolean(),
		tool_failure_count: Type.Number(),
		frustration: Type.Boolean(),
		stuck_loop: Type.Boolean(),
		oscillation: Type.Boolean(),
		preflight_gap: Type.Boolean(),
	}),
	easy: Type.Boolean(),
	hard: Type.Boolean(),
	verdict: RoutingVerdict,
});
export type RoutingProperties = Static<typeof RoutingProperties>;

export const ROUTING_OPPORTUNITY_DEF: AnalyzerDef = {
	id: "routing-opportunity",
	label: "Routing Opportunity (deterministic)",
	description:
		"Labels each turn downshiftable or escalation-worthy from existing friction/trajectory signals (no LLM), attaching the serving model and billed cost so the corpus-level efficiency frontier can be computed honestly.",
	anchorSpan: "pair",
	dependencies: [TURN_PAIR_CORE_DEF.id, TURN_FRUSTRATION_DEF.id, TOOL_TRAJECTORY_DEF.id],
	outputSchema: RoutingProperties,
};

export const ROUTING_OPPORTUNITY_VERSION: AnalyzerVersion = {
	analyzerId: ROUTING_OPPORTUNITY_DEF.id,
	major: 1,
	minor: 1,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/routing-opportunity/index.ts",
};

type DbUsageRow = { id: string; usage: string | null };

// ── turn feature computation (measurement, exported for unit tests) ──

interface TurnInputs {
	pair: TurnPair;
	core: {
		correction_detected: boolean;
		tool_failure_count: number;
		friction_score: number;
		deliberation_paragraphs: number | null;
	} | null;
	frustration: boolean;
	trajectorySignals: Array<{ pattern: string; messageIds: string[] }>;
	modelByMessageId: Map<string, string | null>;
	costByMessageId: Map<string, number>;
	usageByMessageId: Map<string, { input: number; cacheRead: number }>;
	cfg: RoutingConfig;
}

export function evaluateTurn(inputs: TurnInputs): RoutingProperties {
	const pair = inputs.pair;
	const modelRecorded0 = pair.messageIds.map((id) => inputs.modelByMessageId.get(id)).find((m) => m != null && m.length > 0);
	const model = modelRecorded0 && modelRecorded0.length > 0 ? modelRecorded0 : "unrecorded";
	const modelRecorded = !!modelRecorded0 && modelRecorded0.length > 0;

	// Turn cost: sum of billed assistant steps in the turn.
	let cost = 0;
	let pricedSteps = 0;
	for (const id of pair.messageIds) {
		const c = inputs.costByMessageId.get(id);
		if (typeof c === "number" && Number.isFinite(c) && c > 0) {
			cost += c;
			pricedSteps++;
		}
	}
	const turnCostUsd = pricedSteps > 0 ? cost : null;

	// Context size at the turn: final step of the turn (or max across steps).
	let contextTokens = 0;
	for (const id of pair.messageIds) {
		const u = inputs.usageByMessageId.get(id);
		if (u) contextTokens = Math.max(contextTokens, u.input + u.cacheRead);
	}

	// Edit size: summed byte lengths of edit/apply tool results in the turn.
	let editChars = 0;
	for (const r of pair.toolResults) {
		if (r.toolName === "edit" || r.toolName === "apply_patch" || r.toolName === "apply") {
			editChars += r.textLength;
		}
	}

	const toolCallCount = pair.toolCalls.length;
	const correction = inputs.core?.correction_detected ?? false;
	const toolFailure = inputs.core?.tool_failure_count ?? 0;
	// Deliberation paragraphs come from the turn-pair-core node; null means no
	// reasoning was recorded for the turn — absence of evidence, never read as
	// "no thinking happened" (so it never blocks easiness on its own).
	const deliberationParagraphs = inputs.core?.deliberation_paragraphs ?? null;

	// Which trajectory pathologies touch this turn (by message id overlap).
	let stuckLoop = false;
	let oscillation = false;
	let preflightGap = false;
	const turnMsgIds = new Set(pair.messageIds);
	for (const s of inputs.trajectorySignals) {
		if (s.pattern !== "stuck-loop" && s.pattern !== "polling-loop" && s.pattern !== "oscillation" && s.pattern !== "pre-flight-gap") continue;
		if (!s.messageIds.some((id) => turnMsgIds.has(id))) continue;
		if (s.pattern === "stuck-loop" || s.pattern === "polling-loop") stuckLoop = true;
		if (s.pattern === "oscillation") oscillation = true;
		if (s.pattern === "pre-flight-gap") preflightGap = true;
	}

	const hard = correction || stuckLoop || oscillation || preflightGap;
	const easy =
		!hard &&
		toolCallCount <= inputs.cfg.easyToolCallMax &&
		contextTokens <= inputs.cfg.easyContextTokensMax &&
		editChars <= inputs.cfg.easyEditCharsMax &&
		(deliberationParagraphs ?? 0) <= inputs.cfg.easyDeliberationParagraphsMax;

	const verdict: RoutingVerdict = hard ? "escalate" : easy ? "downshift" : "neutral";

	return {
		user_message_id: pair.userMessageId,
		pair_index: pair.index,
		model,
		model_recorded: modelRecorded,
		turn_cost_usd: turnCostUsd,
		features: {
			tool_call_count: toolCallCount,
			deliberation_paragraphs: deliberationParagraphs,
			context_tokens: contextTokens,
			edit_chars: editChars,
			correction_detected: correction,
			tool_failure_count: toolFailure,
			frustration: inputs.frustration,
			stuck_loop: stuckLoop,
			oscillation,
			preflight_gap: preflightGap,
		},
		easy,
		hard,
		verdict,
	};
}

// ── analyzer ──

export const routingOpportunityAnalyzer: Analyzer = {
	def: ROUTING_OPPORTUNITY_DEF,
	version: ROUTING_OPPORTUNITY_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: ROUTING_OPPORTUNITY_DEF.id,
		configHash: computeConfigHash(DEFAULT_ROUTING_CONFIG),
		configJson: DEFAULT_ROUTING_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		const cfg = (ctx.config as unknown as RoutingConfig) ?? DEFAULT_ROUTING_CONFIG;

		// Per-message model / cost maps from the loaded MessageRows.
		const modelByMessageId = new Map<string, string | null>();
		const costByMessageId = new Map<string, number>();
		for (const m of ctx.messages) {
			modelByMessageId.set(m.id, m.model);
			if (typeof m.cost_usd === "number" && m.cost_usd > 0) costByMessageId.set(m.id, m.cost_usd);
		}

		// Per-message usage (input + cacheRead) — not on MessageRow, so one direct
		// query (same pattern as context-economy).
		const usageByMessageId = new Map<string, { input: number; cacheRead: number }>();
		const usageRows = (await ctx.db.prepare("SELECT id, usage FROM messages WHERE session_id = ?").all(ctx.sessionId)) as DbUsageRow[];
		for (const r of usageRows) {
			if (!r.usage) continue;
			try {
				const u = JSON.parse(r.usage) as Record<string, number>;
				usageByMessageId.set(r.id, { input: u["input"] ?? 0, cacheRead: u["cacheRead"] ?? 0 });
			} catch {
				/* ignore malformed usage */
			}
		}

		// turn-pair-core per-turn properties, keyed by user_message_id.
		const coreProps = new Map<string, { correction_detected: boolean; tool_failure_count: number; friction_score: number; deliberation_paragraphs: number | null }>();
		for (const n of ctx.dependencyNodes[TURN_PAIR_CORE_DEF.id] ?? []) {
			try {
				const c = JSON.parse(n.content_json) as { user_message_id?: string; correction_detected?: boolean; tool_failure_count?: number; friction_score?: number; deliberation_paragraphs?: number | null };
				if (typeof c.user_message_id === "string") {
					coreProps.set(c.user_message_id, {
						correction_detected: !!c.correction_detected,
						tool_failure_count: typeof c.tool_failure_count === "number" ? c.tool_failure_count : 0,
						friction_score: typeof c.friction_score === "number" ? c.friction_score : 0,
						deliberation_paragraphs: typeof c.deliberation_paragraphs === "number" ? c.deliberation_paragraphs : null,
					});
				}
			} catch {
				/* skip */
			}
		}

		// Frustration by user_message_id from turn-frustration nodes.
		const frustrationTurns = new Set<string>();
		for (const n of ctx.dependencyNodes[TURN_FRUSTRATION_DEF.id] ?? []) {
			try {
				const c = JSON.parse(n.content_json) as { user_message_id?: string };
				if (typeof c.user_message_id === "string") frustrationTurns.add(c.user_message_id);
			} catch {
				/* skip */
			}
		}

		// Trajectory signals (session-level) — collect the patterns + message ids.
		const trajectorySignals: Array<{ pattern: string; messageIds: string[] }> = [];
		for (const n of ctx.dependencyNodes[TOOL_TRAJECTORY_DEF.id] ?? []) {
			try {
				const c = JSON.parse(n.content_json) as Partial<ToolTrajectoryProperties>;
				if (Array.isArray(c.signals)) {
					for (const s of c.signals as Array<{ pattern: string; messageIds: string[] }>) {
						trajectorySignals.push({ pattern: s.pattern, messageIds: Array.isArray(s.messageIds) ? s.messageIds : [] });
					}
				}
			} catch {
				/* skip */
			}
		}

		const units: AnalysisUnit[] = [];
		for (const pair of await ctx.getTurnPairs(ctx.sessionId)) {
			const core = coreProps.get(pair.userMessageId) ?? null;
			const frustration = frustrationTurns.has(pair.userMessageId);
			const properties = evaluateTurn({
				pair,
				core,
				frustration,
				trajectorySignals,
				modelByMessageId,
				costByMessageId,
				usageByMessageId,
				cfg,
			});
			// Part of the unit's identity: the turn's messages + the dependency
			// nodes that fed the label (turn-pair-core + trajectory + frustration
			// output keys), so a changed signal re-labels the turn.
			const sources: SourceRef[] = [
				...pair.messageIds.map((id) => ({ kind: "message" as const, id })),
				...(ctx.dependencyNodes[TURN_PAIR_CORE_DEF.id] ?? [])
					.filter((n) => {
						try {
							return (JSON.parse(n.content_json) as { user_message_id?: string }).user_message_id === pair.userMessageId;
						} catch {
							return false;
						}
					})
					.map((n) => ({ kind: "analysis_node" as const, id: n.output_key })),
			];
			units.push({
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "message",
				anchorRef: pair.userMessageId,
				meta: { properties },
			});
		}
		return units;
	},

	analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): AnalysisResult {
		const properties = (unit.meta?.["properties"] as RoutingProperties) ?? {
			user_message_id: unit.anchorRef,
			pair_index: -1,
			model: "unrecorded",
			model_recorded: false,
			turn_cost_usd: null,
			features: {
				tool_call_count: 0,
				deliberation_paragraphs: null,
				context_tokens: 0,
				edit_chars: 0,
				correction_detected: false,
				tool_failure_count: 0,
				frustration: false,
				stuck_loop: false,
				oscillation: false,
				preflight_gap: false,
			},
			easy: false,
			hard: false,
			verdict: "neutral",
		};
		return {
			nodeKind: "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "message",
			anchorRef: unit.anchorRef,
			edges: [
				{ toRefKind: REF_KINDS.MESSAGE, toRefId: unit.anchorRef, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
			],
		};
	},
};
