/**
 * friction-accumulation — deterministic session-level friction decline
 * detection (issue #101).
 *
 * Every shipped friction signal is per-turn or per-pair; nothing accumulates
 * them across a session, so a slow decline — each turn slightly worse than the
 * last, none bad enough to trip any per-turn threshold — is invisible. This
 * analyzer consumes the existing deterministic per-turn signals and accumulates
 * them into a session-level running score over the turn sequence, then flags a
 * rising rate (see `detect.ts` for the documented heuristic):
 *
 *   - turn-pair-core    → each turn's deterministic friction score
 *   - turn-frustration  → learned lexicon / paralinguistic hit weights per turn
 *   - tool-trajectory   → session-level trajectory patterns, attributed once to
 *                         the turn where each signal culminates
 *
 * Declared as dependencies on those three analyzers, so their node outputs are
 * this unit's source set: because consumers reference sources by output key,
 * a changed upstream conclusion re-identifies this unit and forces honest
 * recomputation (DESIGN.md, Merkle DAG).
 *
 * One node per session: metric by default; when the decline clears its config
 * gates AND total accumulated friction reaches `proposalMinAccumulated`, the
 * node carries `improvement_proposals` and is emitted as kind `proposal`,
 * following the failure-modes/files-in-play convention for deterministic
 * analyzers — the framework materialises those into the proposal store. A
 * clean or steady session still gets its metric node: it is measured, never
 * skipped.
 */

import type {
	Analyzer,
	AnalyzerDef,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	AnalysisNodeRow,
	AnalysisResult,
	AnalysisUnit,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeConfigHash, computeSourceSetHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { Type, type Static } from "typebox";
import { TURN_PAIR_CORE_DEF } from "../turn-pair-core/index.js";
import { TURN_FRUSTRATION_DEF } from "../turn-frustration/index.js";
import { TOOL_TRAJECTORY_DEF } from "../tool-trajectory/index.js";
import {
	DEFAULT_FRICTION_ACCUMULATION_CONFIG,
	type FrictionAccumulationConfig,
} from "./config.js";
import {
	computeContributions,
	computeWindowRates,
	evaluateDecline,
	type CoreTurnSignal,
	type TrajectorySignalRef,
	TurnContribution,
	WindowRate,
	DeclineVerdict,
} from "./detect.js";

/** A proposal this analyzer embeds in its node; materialised by the framework. */
export const FrictionAccumulationRawProposal = Type.Object({
	target_type: Type.String(),
	target_path: Type.Optional(Type.String()),
	title: Type.String(),
	summary: Type.String(),
	detail: Type.String(),
	evidence: Type.String(),
	confidence: Type.Number(),
	severity: Type.String(),
});
export type FrictionAccumulationRawProposal = Static<typeof FrictionAccumulationRawProposal>;

/** The properties a friction-accumulation node carries in its `contentJson`. */
export const FRICTION_ACCUMULATION_PROPERTIES = Type.Object({
	session_id: Type.String(),
	turn_count: Type.Number(),
	/** Sum of every turn's contribution over the whole sequence. */
	accumulated_friction: Type.Number(),
	mean_friction: Type.Number(),
	window_size: Type.Number(),
	window_rates: Type.Array(WindowRate),
	decline_verdict: DeclineVerdict,
	/** Per-turn contributions, most recent `maxListedContributions` turns kept. */
	turn_contributions: Type.Array(TurnContribution),
	improvement_proposals: Type.Array(FrictionAccumulationRawProposal),
});
export type FrictionAccumulationProperties = Static<typeof FRICTION_ACCUMULATION_PROPERTIES>;

export const FRICTION_ACCUMULATION_DEF: AnalyzerDef = {
	id: "friction-accumulation",
	label: "Friction Accumulation (deterministic)",
	description:
		"Accumulates the deterministic per-turn friction signals (turn-pair-core scores, lexicon/marker frustration hits, culminating trajectory patterns) into a session-level running score over the turn sequence, and flags a gradual decline: the last window's mean per-turn rate exceeding the first's by a configured threshold. Steady sessions never flag — the signal is the slope, not the level. No LLM.",
	anchorSpan: "full_session",
	dependencies: [TURN_PAIR_CORE_DEF.id, TURN_FRUSTRATION_DEF.id, TOOL_TRAJECTORY_DEF.id],
	outputSchema: FRICTION_ACCUMULATION_PROPERTIES,
};

export const FRICTION_ACCUMULATION_VERSION: AnalyzerVersion = {
	analyzerId: FRICTION_ACCUMULATION_DEF.id,
	// 1.0 (issue #101): accumulation of per-turn deterministic friction signals,
	// window-rate comparison with a recurrence gate, and a proposal earned only
	// above a total-friction floor so noise around clean sessions stays quiet.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/friction-accumulation/index.ts",
};

function resolveConfig(raw: unknown): FrictionAccumulationConfig {
	return (raw as FrictionAccumulationConfig) ?? DEFAULT_FRICTION_ACCUMULATION_CONFIG;
}

/**
 * The newest non-error dependency node per logical unit, keyed by that unit.
 *
 * A dependency may carry several live versions of one logical unit after a
 * revise run (same source set, different recipe). Only the newest is real
 * input; folding older versions in would double-count turns and pollute the
 * identity with conclusions the graph no longer considers current. Iterating
 * in `created_at ASC` order and overwriting keeps the newest.
 */
function latestByKey(nodes: readonly AnalysisNodeRow[], keyOf: (props: Record<string, unknown>) => string | null): AnalysisNodeRow[] {
	const byKey = new Map<string, AnalysisNodeRow>();
	for (const node of nodes) {
		if (node.node_kind === "error") continue;
		let props: Record<string, unknown>;
		try {
			props = JSON.parse(node.content_json) as Record<string, unknown>;
		} catch {
			continue;
		}
		const key = keyOf(props);
		if (!key) continue;
		byKey.set(key, node);
	}
	return [...byKey.values()];
}

interface DependencyInputs {
	coreNodes: AnalysisNodeRow[];
	frustrationNodes: AnalysisNodeRow[];
	trajectoryNodes: AnalysisNodeRow[];
}

function gatherDependencies(
	dependencyNodes: Record<string, AnalysisNodeRow[]>,
): DependencyInputs {
	return {
		coreNodes: latestByKey(dependencyNodes[TURN_PAIR_CORE_DEF.id] ?? [], (p) =>
			typeof p["user_message_id"] === "string" ? (p["user_message_id"] as string) : null),
		frustrationNodes: latestByKey(dependencyNodes[TURN_FRUSTRATION_DEF.id] ?? [], (p) => {
			if (typeof p["user_message_id"] !== "string") return null;
			const source = typeof p["signal_source"] === "string" ? p["signal_source"] : "";
			const signal = typeof p["signal"] === "string" ? p["signal"] : "";
			return `${p["user_message_id"] as string}\u0000${source}\u0000${signal}`;
		}),
		trajectoryNodes: latestByKey(dependencyNodes[TOOL_TRAJECTORY_DEF.id] ?? [], () => "session"),
	};
}

/**
 * Build at most one proposal. The gate is two-fold: the decline must be
 * detected (slope across both windows, past the recurrence gate), AND the
 * session's total accumulated friction must reach `proposalMinAccumulated` —
 * a rise between near-zero windows is noise, not a declining session.
 */
function buildProposal(
	properties: Omit<FrictionAccumulationProperties, "improvement_proposals">,
	config: FrictionAccumulationConfig,
): FrictionAccumulationRawProposal | null {
	if (!properties.decline_verdict.decline_detected) return null;
	if (properties.accumulated_friction < config.proposalMinAccumulated) return null;

	const tail = properties.turn_contributions.slice(-config.windowSize);
	const evidenceTail = tail
		.map((c) => `#${c.pair_index} score=${c.core_score.toFixed(2)}${c.frustration_weight > 0 ? ` frust=${c.frustration_weight.toFixed(2)}` : ""}${c.trajectory_weight > 0 ? ` traj=${c.trajectory_weight.toFixed(2)}` : ""}`)
		.join("; ");
	return {
		target_type: "agents_md",
		title: "Friction is accumulating: the session gets steadily harder as it goes",
		summary:
			`Per-turn friction rose from ${properties.decline_verdict.first_window_rate.toFixed(2)} to ${properties.decline_verdict.last_window_rate.toFixed(2)} ` +
			`(Δ=${properties.decline_verdict.decline_delta.toFixed(2)}) between the first and last ${config.windowSize}-turn windows, ` +
			`accumulating ${properties.accumulated_friction.toFixed(2)} total friction over ${properties.turn_count} turns. ` +
			"No single turn tripped a threshold; the slope is the problem.",
		detail:
			"Add a standing instruction to checkpoint before continuing after repeated corrections or failures: when two consecutive turns add friction, restate what is settled, drop failed approaches explicitly, and prefer restarting the sub-task cleanly over pushing the degraded thread forward. Gradual drift compounds precisely because each step looks survivable on its own.",
		evidence:
			`Window rates ${properties.decline_verdict.first_window_rate.toFixed(2)} → ${properties.decline_verdict.last_window_rate.toFixed(2)} over ` +
			`${properties.window_rates.length} complete windows of ${config.windowSize}; heaviest recent turns: ${evidenceTail}`,
		confidence: 0.6,
		severity: "friction",
	};
}

export const frictionAccumulationAnalyzer: Analyzer = {
	def: FRICTION_ACCUMULATION_DEF,
	version: FRICTION_ACCUMULATION_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: FRICTION_ACCUMULATION_DEF.id,
		configHash: computeConfigHash(DEFAULT_FRICTION_ACCUMULATION_CONFIG),
		configJson: DEFAULT_FRICTION_ACCUMULATION_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	/**
	 * One unit per session, planned from the upstream nodes' OUTPUT KEYS alone
	 * (cheap fingerprint work — the math happens in analyze()). Because the
	 * source set references upstream conclusions by output key, any recomputed
	 * upstream verdict changes this unit's identity and honestly marks the old
	 * result out of date; nothing here reads raw conversation, so there is no
	 * separate conversation fingerprint to maintain.
	 *
	 * With no turn-pair-core nodes yet there is nothing to accumulate — the
	 * framework runs declared dependencies first within a session, so this only
	 * means an empty conversation, which yields no units (an empty session has
	 * no turns to accumulate, and inventing an all-zero one would lie).
	 */
	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		const { coreNodes, frustrationNodes, trajectoryNodes } = gatherDependencies(ctx.dependencyNodes);
		if (coreNodes.length === 0) return [];

		const consumed = [...coreNodes, ...frustrationNodes, ...trajectoryNodes];
		const sources: SourceRef[] = consumed.map((n) => ({ kind: "analysis_node", id: n.output_key }));
		return [
			{
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
			},
		];
	},

	async analyze(_unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const { coreNodes, frustrationNodes, trajectoryNodes } = gatherDependencies({
			[TURN_PAIR_CORE_DEF.id]: await ctx.getDependencyNodes(TURN_PAIR_CORE_DEF.id),
			[TURN_FRUSTRATION_DEF.id]: await ctx.getDependencyNodes(TURN_FRUSTRATION_DEF.id),
			[TOOL_TRAJECTORY_DEF.id]: await ctx.getDependencyNodes(TOOL_TRAJECTORY_DEF.id),
		});

		const coreTurns: CoreTurnSignal[] = [];
		for (const node of coreNodes) {
			try {
				const c = JSON.parse(node.content_json) as Partial<Record<"pair_index" | "user_message_id" | "friction_score", unknown>>;
				if (typeof c.user_message_id !== "string" || typeof c.pair_index !== "number") continue;
				coreTurns.push({
					pair_index: c.pair_index,
					user_message_id: c.user_message_id,
					friction_score: typeof c.friction_score === "number" ? c.friction_score : 0,
				});
			} catch {
				continue;
			}
		}
		coreTurns.sort((a, b) => a.pair_index - b.pair_index);

		// Frustration hit weights summed per turn, from the per-(turn, signal) nodes.
		const frustrationWeightByTurnId = new Map<string, number>();
		for (const node of frustrationNodes) {
			try {
				const c = JSON.parse(node.content_json) as { user_message_id?: string; weight?: number };
				if (typeof c.user_message_id !== "string") continue;
				const weight = typeof c.weight === "number" ? c.weight : 0;
				frustrationWeightByTurnId.set(c.user_message_id, (frustrationWeightByTurnId.get(c.user_message_id) ?? 0) + weight);
			} catch {
				continue;
			}
		}

		const trajectorySignals: TrajectorySignalRef[] = [];
		for (const node of trajectoryNodes) {
			try {
				const c = JSON.parse(node.content_json) as { signals?: Array<{ pattern?: string; messageIds?: string[] }> };
				for (const s of Array.isArray(c.signals) ? c.signals : []) {
					if (typeof s.pattern !== "string") continue;
					trajectorySignals.push({ pattern: s.pattern, messageIds: Array.isArray(s.messageIds) ? s.messageIds : [] });
				}
			} catch {
				continue;
			}
		}

		// Trajectory attribution maps participating message ids back to their turn.
		const messageToUserMessageId = new Map<string, string>();
		for (const pair of await ctx.getTurnPairs(ctx.sessionId)) {
			for (const id of pair.messageIds) messageToUserMessageId.set(id, pair.userMessageId);
		}

		const contributions = computeContributions(coreTurns, frustrationWeightByTurnId, trajectorySignals, messageToUserMessageId, config);
		const rates = computeWindowRates(contributions, config.windowSize);
		const verdict = evaluateDecline(contributions, rates, config);

		const listed = contributions.slice(-config.maxListedContributions);
		const accumulatedFriction = contributions.reduce((sum, c) => sum + c.contribution, 0);
		const base = {
			session_id: ctx.sessionId,
			turn_count: contributions.length,
			accumulated_friction: accumulatedFriction,
			mean_friction: contributions.length > 0 ? accumulatedFriction / contributions.length : 0,
			window_size: config.windowSize,
			window_rates: rates,
			decline_verdict: verdict,
			turn_contributions: listed,
		};
		const proposal = buildProposal(base, config);
		const properties: FrictionAccumulationProperties = { ...base, improvement_proposals: proposal ? [proposal] : [] };

		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
		];
		// Anchor to the turns of the last window — where the decline concentrated —
		// so the finding walks back to the exact moments the slope was earned.
		let ordinal = 1;
		for (const contribution of listed.slice(-config.windowSize)) {
			edges.push({ toRefKind: REF_KINDS.MESSAGE, toRefId: contribution.user_message_id, edgeKind: EDGE_KINDS.ANCHORS, ordinal: ordinal++ });
		}

		return {
			nodeKind: proposal ? "proposal" : "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			edges,
		};
	},
};
