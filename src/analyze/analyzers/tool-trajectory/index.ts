/**
 * tool-trajectory — deterministic session-level tool-call trajectory analysis.
 *
 * Produces one `metric` node per session, containing all trajectory signals
 * (stuck-loops, polling-loops, oscillations, pre-flight gaps) detected in the
 * session's ordered tool-call stream. No LLM is used: all detectors are pure
 * functions operating on normalised tool-call representations.
 *
 * The analyzer depends on turn-pair-core (to consume its per-turn tool metadata)
 * and emits metric nodes that feed into the session-overview digest.
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
import { TURN_PAIR_CORE_DEF } from "../turn-pair-core/index.js";
import { buildToolStream } from "../../tool-stream.js";
import { normalizeToolCall } from "./arg-parser.js";
import { detectAllSignals, TrajectorySignal, type ReasoningBlock, type ToolCallWithResult } from "./detectors.js";
import { fingerprintReasoning } from "./reasoning-fingerprint.js";
import { DEFAULT_TOOL_TRAJECTORY_CONFIG, type ToolTrajectoryConfig } from "./config.js";
import { Type, type Static } from "typebox";

export const ToolTrajectoryProperties = Type.Object({
	/** Session id this analysis covers. */
	session_id: Type.String(),
	/** All trajectory signals detected. */
	signals: Type.Array(TrajectorySignal),
	/** Aggregate friction contribution from trajectory signals. */
	trajectory_friction_score: Type.Number(),
	/**
	 * The sum of the billed dollar cost of the signals that could be priced (the
	 * sum of each priced signal's `cost_usd`), or null when none could be priced.
	 * Money is never guessed: an unpriced signal contributes nothing.
	 * When `unpriced_signal_count > 0` this is a LOWER BOUND of the session's true
	 * trajectory cost — it is never presented as a complete total when any signal
	 * is unpriced. See `priced_signal_count`/`unpriced_signal_count` for coverage.
	 */
	trajectory_cost_usd: Type.Union([Type.Number(), Type.Null()]),
	/**
	 * How many of `signals` carry a recorded cost. Together with
	 * `unpriced_signal_count` this states what fraction of the trajectory could
	 * be priced, so a partial pricing is visible rather than silently omitted.
	 */
	priced_signal_count: Type.Number(),
	/** How many of `signals` could not be priced (no recorded cost on the turns). */
	unpriced_signal_count: Type.Number(),
	/** Counts per pattern. */
	pattern_counts: Type.Record(Type.String(), Type.Number()),
	/** Total number of tool calls analysed. */
	tool_call_count: Type.Number(),
});
export type ToolTrajectoryProperties = Static<typeof ToolTrajectoryProperties>;

export const TOOL_TRAJECTORY_DEF: AnalyzerDef = {
	id: "tool-trajectory",
	label: "Tool-Call Trajectory (deterministic)",
	description:
		"Detects stuck-loops, polling-loops, action oscillation, pre-flight gaps, and thought-oscillation (repeated near-duplicate reasoning without progress) in the ordered session stream. No LLM.",
	anchorSpan: "full_session",
	dependencies: [TURN_PAIR_CORE_DEF.id],
	outputSchema: ToolTrajectoryProperties,
};

export const TOOL_TRAJECTORY_VERSION: AnalyzerVersion = {
	analyzerId: TOOL_TRAJECTORY_DEF.id,
	// 1.1 (issue #71): each signal now prices itself — `cost_usd` carries the
	// billed dollar sum of the participating assistant turns, and the node adds a
	// `trajectory_cost_usd` aggregate. Minor: output gains fields; the detection
	// semantics are unchanged. This is what lets a loop read as "$0.34" instead
	// of "repeated 9×" in proposal evidence, and it also enriches the digest the
	// synthesizer sees (riding the recompute the shape change already forces).
	// 1.2: the framework loader now carries per-message cost/model to
	// every consumer, so signals actually price. The output also gains
	// `priced_signal_count`/`unpriced_signal_count` so a trajectory priced from
	// partial data states what fraction it could price, and `trajectory_cost_usd`
	// is now documented as the sum of the *priced* signals — a lower bound of the
	// true cost whenever any signal is unpriced, never a silent total.
	// Minor: output gains fields; detection semantics unchanged.
	//
	// 2.0 (issue #159): calls and results are now paired by the provider's
	// tool-call id, through the shared session action stream, instead of by
	// position. The old positional walk mis-attributed every error whenever one
	// step issued several calls or a call never returned — and `isError` is what
	// decides whether a run of repeats counts as a stuck-loop. Major: previously
	// reported signals can disappear and new ones appear, because the inputs to
	// the detectors were wrong.
	//
	// 3.0 (issue #117): new thought-oscillation detector — repeated near-duplicate
	// private reasoning without progress, fingerprinted over normalised prose
	// shingles. The node output changes shape (a new pattern can appear in
	// `signals`, and signals may carry `similarity`), and detection semantics
	// widen: sessions whose agent looped in thought now produce a signal they
	// previously lacked. Major: old nodes are revised cleanly under --revise major,
	// preserving their conclusions as lineage beside the revision.
	major: 3,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/tool-trajectory/index.ts",
};

// ──────────────────────────── the action stream ────────────────────────────

/**
 * Adapt the session's shared action stream to what the detectors expect.
 *
 * The pairing itself lives in `src/analyze/tool-stream.ts`, alongside turn
 * failures, so this analyzer and `failure-modes` agree on what "that call
 * failed" means. Before it did, this analyzer paired the Nth call with the Nth
 * result gathered from a map — which put every error on the wrong call in any
 * session where one step issued several calls, or where a call never got a
 * result at all. Loop detection reads `isError` to decide whether a run of
 * repeats ever succeeded, so the mis-attribution silently changed which loops
 * were reported.
 *
 * A call with no recorded result is treated as *not* an error: the session
 * simply ended before the answer arrived, and inventing a failure there would
 * manufacture stuck-loops out of clean tails.
 */
function extractToolCalls(messages: MessageRow[]): ToolCallWithResult[] {
	return buildToolStream(messages).invocations.map((inv) => ({
		call: normalizeToolCall({ name: inv.name, args: inv.args, messageId: inv.messageId }),
		isError: inv.outcome?.isError ?? false,
		resultMessageId: inv.outcome?.messageId ?? "",
		costUsd: inv.costUsd,
	}));
}

/**
 * Extract the reasoning blocks the thought-oscillation detector consumes:
 * every assistant message carrying private reasoning, tagged with its turn
 * ordinal and whether its own turn also made a state-changing tool call.
 *
 * A turn spans everything between two user messages (DESIGN.md §2), so a block
 * is disqualified when ANY state-changing call lands anywhere in that span —
 * re-think-then-act made progress and is not oscillation. Blocks whose prose
 * is too short to fingerprint are skipped entirely.
 */
function extractReasoningBlocks(messages: MessageRow[]): ReasoningBlock[] {
	const blocks: ReasoningBlock[] = [];
	let turnIndex = -1;
	let currentTurnStateChanging = false;
	for (const m of messages) {
		if (m.role === "user") {
			turnIndex++;
			currentTurnStateChanging = false;
			continue;
		}
		if (m.tool_calls) {
			let parsed: Array<{ name?: unknown; arguments?: Record<string, unknown> }>;
			try {
				parsed = JSON.parse(m.tool_calls) as Array<{ name?: unknown; arguments?: Record<string, unknown> }>;
			} catch (e) {
				throw new Error(`tool-trajectory: unparseable tool_calls JSON on message ${m.id}: ${String(e)}`);
			}
			for (const c of parsed) {
				if (typeof c.name !== "string") continue;
				if (!normalizeToolCall({ name: c.name, args: c.arguments ?? {}, messageId: m.id }).readOnly) {
					currentTurnStateChanging = true;
				}
			}
		}
		if (m.role !== "assistant") continue;
		const thinking = m.content_thinking;
		if (!thinking) continue;
		const fingerprinted = fingerprintReasoning(thinking);
		if (!fingerprinted) continue;
		blocks.push({
			messageId: m.id,
			turnIndex: Math.max(turnIndex, 0),
			stateChanging: currentTurnStateChanging,
			fingerprint: fingerprinted,
			costUsd: m.cost_usd,
		});
	}
	return blocks;
}

/**
 * Compute the trajectory friction score from detected signals.
 * Each signal pattern has a weight; the score is the sum of weights,
 * clamped to [0, 1].
 */
function computeTrajectoryFriction(
	signals: TrajectorySignal[],
	config: ToolTrajectoryConfig,
): number {
	let score = 0;
	for (const signal of signals) {
		switch (signal.pattern) {
			case "stuck-loop":
				score += config.stuckLoopWeight;
				break;
			case "polling-loop":
				score += config.pollingLoopWeight;
				break;
			case "oscillation":
				score += config.oscillationWeight;
				break;
			case "pre-flight-gap":
				score += config.preFlightGapWeight;
				break;
			case "thought-oscillation":
				score += config.thoughtOscillationWeight;
				break;
		}
	}
	return Math.max(0, Math.min(1, score));
}

// ──────────────────────────── analyzer ────────────────────────────

export const toolTrajectoryAnalyzer: Analyzer = {
	def: TOOL_TRAJECTORY_DEF,
	version: TOOL_TRAJECTORY_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: TOOL_TRAJECTORY_DEF.id,
		configHash: computeConfigHash(DEFAULT_TOOL_TRAJECTORY_CONFIG),
		configJson: DEFAULT_TOOL_TRAJECTORY_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		// One unit per session, consuming turn-pair-core nodes.
		const coreNodes = ctx.dependencyNodes[TURN_PAIR_CORE_DEF.id] ?? [];
		if (coreNodes.length === 0 && ctx.messages.length === 0) return [];

		const sources: SourceRef[] = [
			...coreNodes.map((n) => ({ kind: "analysis_node" as const, id: n.output_key })),
		];
		// Also anchor to the session itself
		return [
			{
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
			},
		];
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = (ctx.config.configJson as unknown as ToolTrajectoryConfig) ?? DEFAULT_TOOL_TRAJECTORY_CONFIG;
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		const toolCalls = extractToolCalls(messages);

		const signals = detectAllSignals(toolCalls, extractReasoningBlocks(messages), {
			stuckLoopMin: config.stuckLoopMin,
			pollingLoopMin: config.pollingLoopMin,
			oscillationWindow: config.oscillationWindow,
			thoughtOscillationSimilarity: config.thoughtOscillationSimilarity,
			thoughtOscillationMinRepeat: config.thoughtOscillationMinRepeat,
		});

		const trajectoryFriction = computeTrajectoryFriction(signals, config);

		const patternCounts: Record<string, number> = {};
		for (const s of signals) {
			patternCounts[s.pattern] = (patternCounts[s.pattern] ?? 0) + 1;
		}

		// Aggregate billed cost across signals: a session whose loops burned money
		// is worth surfacing even when each individual signal is modest. The
		// aggregate is the sum of the *priced* signals only — never a synthetic 0,
		// and never presented as a complete total when any signal is unpriced. The
		// priced/unpriced counts state the coverage so a partial pricing is visible.
		let trajectoryCostUsd: number | null = null;
		let pricedCount = 0;
		let unpricedCount = 0;
		{
			let sum = 0;
			for (const s of signals) {
				if (typeof s.cost_usd === "number" && Number.isFinite(s.cost_usd) && s.cost_usd > 0) {
					sum += s.cost_usd;
					pricedCount++;
				} else {
					unpricedCount++;
				}
			}
			// A signal whose participating turns recorded a cost always prices
			// non-null, so a non-empty priced count implies a positive sum.
			trajectoryCostUsd = pricedCount > 0 ? sum : null;
		}

		const properties: ToolTrajectoryProperties = {
			session_id: ctx.sessionId,
			signals,
			trajectory_friction_score: trajectoryFriction,
			trajectory_cost_usd: trajectoryCostUsd,
			priced_signal_count: pricedCount,
			unpriced_signal_count: unpricedCount,
			pattern_counts: patternCounts,
			tool_call_count: toolCalls.length,
		};

		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
		];
		let ordinal = 1;
		// Consume turn-pair-core nodes
		const coreNodes = await ctx.getDependencyNodes(TURN_PAIR_CORE_DEF.id);
		for (const n of coreNodes) {
			edges.push({ toRefKind: REF_KINDS.ANALYSIS_NODE, toRefId: n.output_key, edgeKind: EDGE_KINDS.CONSUMES, ordinal: ordinal++ });
		}

		return {
			nodeKind: "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			edges,
		};
	},
};