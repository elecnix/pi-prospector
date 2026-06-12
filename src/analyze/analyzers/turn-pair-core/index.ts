/**
 * turn-pair-core — deterministic per-turn friction analysis.
 *
 * Produces one `metric` node per turn pair. No LLM is used: friction signals
 * come from correction-pattern matching, tool failures, empty responses, and
 * tool-output volume. The friction score gates which pairs the LLM enrichment
 * analyzer (turn-pair-llm) bothers to look at.
 */

import type {
	Analyzer,
	AnalyzerDef,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	AnalysisResult,
	AnalysisUnit,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeSourceSetHash, computeConfigHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { buildTurnPairs, type TurnPair } from "./build.js";
import { classifyCorrection, detectRepetition } from "./patterns.js";
import { DEFAULT_TURN_PAIR_CORE_CONFIG, type TurnPairCoreConfig } from "./config.js";

export const TURN_PAIR_CORE_DEF: AnalyzerDef = {
	id: "turn-pair-core",
	label: "Per-Turn Friction (deterministic)",
	description:
		"Scores every user→assistant turn pair deterministically (corrections, tool failures, empty replies, wasted tool output) and extracts a compact tool-action trace — call names, truncated arguments, and failed-result error heads — for downstream analyzers. No LLM; flags high-signal pairs.",
	anchorSpan: "pair",
	dependencies: [],
};

export const TURN_PAIR_CORE_VERSION: AnalyzerVersion = {
	analyzerId: TURN_PAIR_CORE_DEF.id,
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/turn-pair-core/index.ts",
};

export interface TurnPairCoreProperties {
	pair_index: number;
	user_message_id: string;
	correction_detected: boolean;
	correction_type: string | null;
	correction_patterns: string[];
	correction_text: string | null;
	tool_call_count: number;
	tool_failure_count: number;
	tool_result_bytes: number;
	tool_waste_bytes: number;
	empty_response: boolean;
	friction_score: number;
	high_signal: boolean;
}

function scorePair(pair: TurnPair, config: TurnPairCoreConfig): TurnPairCoreProperties {
	const isRepetition = detectRepetition(pair.userText, pair.priorUserText);
	const correction = classifyCorrection(pair.userText, isRepetition);

	const toolFailureCount = pair.toolResults.filter((r) => r.isError).length;
	const toolResultBytes = pair.toolResults.reduce((sum, r) => sum + r.textLength, 0);
	const toolWasteBytes = toolResultBytes > config.toolWasteByteThreshold ? toolResultBytes - config.toolWasteByteThreshold : 0;
	const emptyResponse = pair.assistantText.trim().length === 0 && pair.toolCalls.length === 0;

	let score = 0;
	if (correction.detected) score += config.correctionWeight;
	score += Math.min(toolFailureCount, 3) * config.toolFailureWeight;
	if (emptyResponse) score += config.emptyResponseWeight;
	if (toolWasteBytes > 0) score += config.toolWasteWeight;
	const frictionScore = Math.max(0, Math.min(1, score));

	return {
		pair_index: pair.index,
		user_message_id: pair.userMessageId,
		correction_detected: correction.detected,
		correction_type: correction.type,
		correction_patterns: correction.patterns,
		correction_text: correction.correctionText,
		tool_call_count: pair.toolCalls.length,
		tool_failure_count: toolFailureCount,
		tool_result_bytes: toolResultBytes,
		tool_waste_bytes: toolWasteBytes,
		empty_response: emptyResponse,
		friction_score: frictionScore,
		high_signal: frictionScore >= config.highSignalThreshold,
	};
}

export const turnPairCoreAnalyzer: Analyzer = {
	def: TURN_PAIR_CORE_DEF,
	version: TURN_PAIR_CORE_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: TURN_PAIR_CORE_DEF.id,
		configHash: computeConfigHash(DEFAULT_TURN_PAIR_CORE_CONFIG),
		configJson: DEFAULT_TURN_PAIR_CORE_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		const pairs = buildTurnPairs(ctx.messages);
		return pairs.map((pair) => {
			const sources: SourceRef[] = pair.messageIds.map((id) => ({ kind: "message" as const, id }));
			return {
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "message" as const,
				anchorRef: pair.userMessageId,
				meta: { pair: pair as unknown as Record<string, unknown> },
			};
		});
	},

	analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): AnalysisResult {
		const config = (ctx.config.configJson as unknown as TurnPairCoreConfig) ?? DEFAULT_TURN_PAIR_CORE_CONFIG;
		const pair = unit.meta?.["pair"] as unknown as TurnPair;
		const properties = scorePair(pair, config);

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
