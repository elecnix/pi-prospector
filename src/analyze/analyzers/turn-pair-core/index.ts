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
import { Type, type Static } from "typebox";
import { computeSourceSetHash, computeConfigHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { type TurnPair } from "./build.js";
import { classifyCorrection, detectRepetition, countDeliberationParagraphs } from "./patterns.js";
import { matchRebuttalCandidates } from "../../speech-acts.js";
import { DEFAULT_TURN_PAIR_CORE_CONFIG, type TurnPairCoreConfig } from "./config.js";
import { MESSAGE_ORIGIN_DEF, type MessageOriginProperties } from "../message-origin/index.js";
import { MessageOrigin } from "../../message-origin.js";
import { currentHits } from "../../../db/muted-terms.js";

export const TurnPairCoreProperties = Type.Object({
	pair_index: Type.Number(),
	user_message_id: Type.String(),
	correction_detected: Type.Boolean(),
	correction_type: Type.Union([Type.String(), Type.Null()]),
	correction_patterns: Type.Array(Type.String()),
	correction_text: Type.Union([Type.String(), Type.Null()]),
	/**
	 * True when the user message's wording disputes a claim the assistant made
	 * (issue #318). A **candidate**, not a finding: the model layer confirms or
	 * rejects it. A turn that is both a correction and a rebuttal candidate
	 * keeps its correction — the deterministic layer proposes, it does not
	 * reclassify.
	 */
	rebuttal_candidate: Type.Boolean(),
	/** The regular-expression sources whose wording marked the rebuttal candidate. */
	rebuttal_patterns: Type.Array(Type.String()),
	/**
	 * The verbatim wording that marked the rebuttal candidate — the span the
	 * pattern matched, truncated. Null when no candidate was marked. It is the
	 * evidence the model layer reads, so the prompt shows the user's own words
	 * rather than a paraphrase of them.
	 */
	rebuttal_text: Type.Union([Type.String(), Type.Null()]),
	tool_call_count: Type.Number(),
	/** Paragraphs in the assistant's reasoning; null when no reasoning was recorded for the turn. */
	deliberation_paragraphs: Type.Union([Type.Number(), Type.Null()]),
	tool_failure_count: Type.Number(),
	tool_result_bytes: Type.Number(),
	tool_waste_bytes: Type.Number(),
	empty_response: Type.Boolean(),
	friction_score: Type.Number(),
	high_signal: Type.Boolean(),
	/**
	 * Who wrote the turn's message, from its message-origin node. Absent when the turn
	 * has no node. A correction or rebuttal is detected only in a message that is the
	 * person's (`typed`, or not decided), so a decided `agent`, `notification` or
	 * `pasted` message carries neither.
	 */
	origin: Type.Optional(MessageOrigin),
});
export type TurnPairCoreProperties = Static<typeof TurnPairCoreProperties>;

export const TURN_PAIR_CORE_DEF: AnalyzerDef = {
	id: "turn-pair-core",
	label: "Per-Turn Friction (deterministic)",
	description:
		"Scores every user→assistant turn pair deterministically (corrections, rebuttal candidates, tool failures, empty replies, wasted tool output) and extracts a compact tool-action trace — call names, truncated arguments, and failed-result error heads — for downstream analyzers. No LLM; flags high-signal pairs.",
	anchorSpan: "pair",
	dependencies: [MESSAGE_ORIGIN_DEF.id],
	outputSchema: TurnPairCoreProperties,
};

export const TURN_PAIR_CORE_VERSION: AnalyzerVersion = {
	analyzerId: TURN_PAIR_CORE_DEF.id,
	major: 1,
	// 1.2 (issue #318): a **rebuttal candidate** — the user message's wording
	// disputes a claim the assistant made ("that's wrong", "that flag doesn't
	// exist"). The candidate is additive: the turn's correction detection is
	// untouched, and an instruction ("I told you to use X") stays a correction
	// and never becomes a rebuttal. The model layer (turn-pair-llm) reads the
	// candidate and decides. Additive fields change the node's content, so the
	// version moves and prior verdicts stay reachable through `revises`.
	// 1.3: the turn's message-origin node is an input (a `consumes` edge, kept out of
	// the source set). A message that node labels `agent`, `notification` or `pasted`
	// (decided) is not the person's, so it gets no correction and no rebuttal
	// candidate, and the node records the `origin` it read. Words that disputed the
	// agent inside a brief or a harness notification no longer count as friction.
	minor: 3,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/turn-pair-core/index.ts",
};

/** What a turn's message-origin node says about its message. */
export const ReadOrigin = Type.Object({ origin: MessageOrigin, decided: Type.Boolean() });
export type ReadOrigin = Static<typeof ReadOrigin>;

/** Whether the message's words are the person's to dispute the agent with: not decided as another origin. */
function isPersonsWords(read: ReadOrigin | undefined): boolean {
	return !read || !read.decided || read.origin === "typed";
}

export function scorePair(pair: TurnPair, config: TurnPairCoreConfig, read?: ReadOrigin): TurnPairCoreProperties {
	const persons = isPersonsWords(read);
	const isRepetition = persons && detectRepetition(pair.userText, pair.priorUserText);
	const correction = classifyCorrection(persons ? pair.userText : "", isRepetition);

	const toolFailureCount = pair.toolResults.filter((r) => r.isError).length;
	const toolResultBytes = pair.toolResults.reduce((sum, r) => sum + r.textLength, 0);
	const toolWasteBytes = toolResultBytes > config.toolWasteByteThreshold ? toolResultBytes - config.toolWasteByteThreshold : 0;
	const emptyResponse = pair.assistantText.trim().length === 0 && pair.toolCalls.length === 0;

	// Deliberation: paragraphs in the preserved reasoning text. Reasoning is not
	// always present or preserved (hosts may drop it), so an absent/empty
	// thinkingText carries null — "not recorded" — never 0, which would falsely
	// assert that no thinking happened.
	const deliberationParagraphs = pair.thinkingText.trim().length > 0 ? countDeliberationParagraphs(pair.thinkingText) : null;

	// Rebuttal candidate (issue #318): the wording of the user's message
	// disputes a claim. Additive — the correction above is untouched, so a turn
	// whose wording is a dispute of fact and a turn whose wording is an
	// instruction keep their own identities. The candidate is what the model
	// layer confirms; on its own it is a proposal, not a finding.
	const rebuttalMatches = persons ? matchRebuttalCandidates(pair.userText) : [];

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
		rebuttal_candidate: rebuttalMatches.length > 0,
		rebuttal_patterns: rebuttalMatches.map((m) => m.pattern),
		rebuttal_text: rebuttalMatches.length > 0 ? rebuttalMatches[0]!.text.slice(0, 240) : null,
		tool_call_count: pair.toolCalls.length,
		deliberation_paragraphs: deliberationParagraphs,
		tool_failure_count: toolFailureCount,
		tool_result_bytes: toolResultBytes,
		tool_waste_bytes: toolWasteBytes,
		empty_response: emptyResponse,
		friction_score: frictionScore,
		high_signal: frictionScore >= config.highSignalThreshold,
		...(read ? { origin: read.origin } : {}),
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

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		const pairs = await ctx.getTurnPairs(ctx.sessionId);
		// The newest message-origin node per message. A turn with none keeps the
		// person's-words reading, so a setup that never ran the analyzer scores as before.
		const origins = new Map<string, { read: ReadOrigin; outputKey: string }>();
		for (const node of currentHits(ctx.dependencyNodes[MESSAGE_ORIGIN_DEF.id] ?? [])) {
			try {
				const props = JSON.parse(node.content_json) as MessageOriginProperties;
				origins.set(props.user_message_id, { read: { origin: props.origin, decided: props.decided }, outputKey: node.output_key });
			} catch {
				continue;
			}
		}
		return pairs.map((pair) => {
			const found = origins.get(pair.userMessageId);
			const sources: SourceRef[] = pair.messageIds.map((id) => ({ kind: "message" as const, id }));
			return {
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "message" as const,
				anchorRef: pair.userMessageId,
				meta: { pair: pair as unknown as Record<string, unknown>, origin: found?.read ?? null, originOutputKey: found?.outputKey ?? null },
			};
		});
	},

	analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): AnalysisResult {
		const config = (ctx.config.configJson as unknown as TurnPairCoreConfig) ?? DEFAULT_TURN_PAIR_CORE_CONFIG;
		const pair = unit.meta?.["pair"] as unknown as TurnPair;
		const read = (unit.meta?.["origin"] as ReadOrigin | null | undefined) ?? undefined;
		const originOutputKey = (unit.meta?.["originOutputKey"] as string | null | undefined) ?? null;
		const properties = scorePair(pair, config, read);
		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.MESSAGE, toRefId: unit.anchorRef, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
		];
		if (originOutputKey) {
			edges.push({ toRefKind: REF_KINDS.ANALYSIS_NODE, toRefId: originOutputKey, edgeKind: EDGE_KINDS.CONSUMES, ordinal: 1 });
		}

		return {
			nodeKind: "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "message",
			anchorRef: unit.anchorRef,
			edges,
		};
	},
};
