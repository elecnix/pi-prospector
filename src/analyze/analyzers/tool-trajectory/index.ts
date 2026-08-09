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
import { normalizeToolCall, type NormalizedToolCall } from "./arg-parser.js";
import { detectAllSignals, type TrajectorySignal, type ToolCallWithResult } from "./detectors.js";
import { DEFAULT_TOOL_TRAJECTORY_CONFIG, type ToolTrajectoryConfig } from "./config.js";

export const TOOL_TRAJECTORY_DEF: AnalyzerDef = {
	id: "tool-trajectory",
	label: "Tool-Call Trajectory (deterministic)",
	description:
		"Detects stuck-loops, polling-loops, oscillation, and pre-flight gaps in the ordered tool-call stream. No LLM.",
	anchorSpan: "full_session",
	dependencies: [TURN_PAIR_CORE_DEF.id],
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
	major: 1,
	minor: 2,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/tool-trajectory/index.ts",
};

export interface ToolTrajectoryProperties {
	/** Session id this analysis covers. */
	session_id: string;
	/** All trajectory signals detected. */
	signals: TrajectorySignal[];
	/** Aggregate friction contribution from trajectory signals. */
	trajectory_friction_score: number;
	/**
	 * The sum of the billed dollar cost of the signals that could be priced (the
	 * sum of each priced signal's `cost_usd`), or null when none could be priced.
	 * Money is never guessed: an unpriced signal contributes nothing.
	 * When `unpriced_signal_count > 0` this is a LOWER BOUND of the session's true
	 * trajectory cost — it is never presented as a complete total when any signal
	 * is unpriced. See `priced_signal_count`/`unpriced_signal_count` for coverage.
	 */
	trajectory_cost_usd: number | null;
	/**
	 * How many of `signals` carry a recorded cost. Together with
	 * `unpriced_signal_count` this states what fraction of the trajectory could
	 * be priced, so a partial pricing is visible rather than silently omitted.
	 */
	priced_signal_count: number;
	/** How many of `signals` could not be priced (no recorded cost on the turns). */
	unpriced_signal_count: number;
	/** Counts per pattern. */
	pattern_counts: Record<string, number>;
	/** Total number of tool calls analysed. */
	tool_call_count: number;
}

// ──────────────────────────── message parsing ────────────────────────────

interface ParsedToolCall {
	name: string;
	args: Record<string, unknown>;
	messageId: string;
}

interface ParsedToolResult {
	toolName: string;
	isError: boolean;
	textLength: number;
}

/**
 * Extract tool calls and results from the session's message stream.
 */
function extractToolCalls(messages: MessageRow[]): ToolCallWithResult[] {
	const calls: ParsedToolCall[] = [];
	const resultsByMsgId = new Map<string, ParsedToolResult[]>();

	for (const m of messages) {
		if (m.role === "assistant" && m.tool_calls) {
			try {
				const parsed = JSON.parse(m.tool_calls) as Array<{ name?: unknown; arguments?: unknown; input?: unknown }>;
				for (const tc of parsed) {
					calls.push({
						name: typeof tc.name === "string" ? tc.name : "",
						// Stored tool calls carry their args under `arguments` (see
						// src/sync/parser.ts and turn-pair-core's parseToolCalls). Older or
						// alternate shapes may use `input`; accept it as a fallback so the
						// normaliser always receives the real command string.
						args: (() => {
							const rawArgs = tc.arguments ?? tc.input;
							return rawArgs && typeof rawArgs === "object" ? rawArgs as Record<string, unknown> : {};
						})(),
						messageId: m.id,
					});
				}
			} catch {
				// skip malformed tool_calls
			}
		}
		if (m.role === "toolResult" && m.tool_results) {
			try {
				const parsed = JSON.parse(m.tool_results) as Array<{ toolName?: unknown; isError?: unknown; textLength?: unknown; toolCallId?: unknown }>;
				// Tool results are associated with the preceding assistant message;
				// we pair them by order since they follow the calls.
				for (const tr of parsed) {
					if (typeof tr.toolName === "string") {
						if (!resultsByMsgId.has(m.id)) {
							resultsByMsgId.set(m.id, []);
						}
						resultsByMsgId.get(m.id)!.push({
							toolName: tr.toolName,
							isError: Boolean(tr.isError),
							textLength: typeof tr.textLength === "number" ? tr.textLength : 0,
						});
					}
				}
			} catch {
				// skip malformed tool_results
			}
		}
	}

	// Normalise each call and pair with its result
	const normalized: NormalizedToolCall[] = calls.map((c) =>
		normalizeToolCall(c),
	);

	// Pair calls with their results. Tool results follow the assistant messages
	// that contained the calls, in order. We pair them sequentially.
	let resultIdx = 0;
	const allResults: ParsedToolResult[] = [];
	for (const [, results] of resultsByMsgId) {
		allResults.push(...results);
	}

	// The billed dollar cost of each call's assistant turn, so every detected
	// signal can be priced (issue #71). Unrecorded/zero costs stay absent; money
	// is never invented.
	const costByMsgId = new Map<string, number>();
	for (const m of messages) {
		if (typeof m.cost_usd === "number" && m.cost_usd > 0) costByMsgId.set(m.id, m.cost_usd);
	}

	const withResults: ToolCallWithResult[] = normalized.map((nc, i) => {
		// Each call should have a corresponding result; if not, assume success
		const result = allResults[resultIdx];
		resultIdx++;
		return {
			call: nc,
			isError: result?.isError ?? false,
			resultMessageId: "",
			costUsd: costByMsgId.get(nc.messageId) ?? null,
		};
	});

	return withResults;
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

	analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): AnalysisResult {
		const config = (ctx.config.configJson as unknown as ToolTrajectoryConfig) ?? DEFAULT_TOOL_TRAJECTORY_CONFIG;
		const messages = ctx.getSessionMessages(ctx.sessionId);
		const toolCalls = extractToolCalls(messages);

		const signals = detectAllSignals(toolCalls, {
			stuckLoopMin: config.stuckLoopMin,
			pollingLoopMin: config.pollingLoopMin,
			oscillationWindow: config.oscillationWindow,
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
		const coreNodes = ctx.getDependencyNodes(TURN_PAIR_CORE_DEF.id);
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