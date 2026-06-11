/**
 * turn-pair-llm — cheap LLM enrichment of high-signal turn pairs.
 *
 * Depends on turn-pair-core. Only pairs that the deterministic pass flagged as
 * `high_signal` are sent to the model, keeping cost bounded. Produces one
 * `classification` node per enriched pair, consuming the core metric node.
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
import { buildTurnPairs } from "../turn-pair-core/build.js";
import { TURN_PAIR_CORE_DEF, type TurnPairCoreProperties } from "../turn-pair-core/index.js";
import {
	CLASSIFY_PROMPT,
	CLASSIFY_PROMPT_HASH,
	buildClassifyPrompt,
	parseClassifyResponse,
	type TurnPairLLMProperties,
} from "./prompt.js";
import { DEFAULT_TURN_PAIR_LLM_CONFIG, type TurnPairLLMConfig } from "./config.js";

export const TURN_PAIR_LLM_DEF: AnalyzerDef = {
	id: "turn-pair-llm",
	label: "Per-Turn Classification (LLM)",
	description: "Classifies sentiment and friction for high-signal turn pairs using a cheap model.",
	anchorSpan: "pair",
	dependencies: [TURN_PAIR_CORE_DEF.id],
};

export const TURN_PAIR_LLM_VERSION: AnalyzerVersion = {
	analyzerId: TURN_PAIR_LLM_DEF.id,
	versionId: "1.0.0",
	implementationKind: "in_process_llm",
	codeRef: "src/analyze/analyzers/turn-pair-llm/index.ts",
};

const PROMPTS: Record<string, PromptVersion> = {
	classify: { hash: CLASSIFY_PROMPT_HASH, content: CLASSIFY_PROMPT, role: "classify" },
};

interface EnrichMeta {
	userText: string;
	assistantText: string;
	correctionText: string | null;
	coreNodeId: string;
}

export const turnPairLLMAnalyzer: Analyzer = {
	def: TURN_PAIR_LLM_DEF,
	version: TURN_PAIR_LLM_VERSION,
	prompts: PROMPTS,
	defaultConfig: {
		id: "",
		analyzerId: TURN_PAIR_LLM_DEF.id,
		configHash: computeConfigHash(DEFAULT_TURN_PAIR_LLM_CONFIG),
		configJson: DEFAULT_TURN_PAIR_LLM_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		const coreNodes = ctx.dependencyNodes[TURN_PAIR_CORE_DEF.id] ?? [];
		const pairs = buildTurnPairs(ctx.messages);
		const pairByUserId = new Map(pairs.map((p) => [p.userMessageId, p]));

		const units: AnalysisUnit[] = [];
		for (const node of coreNodes) {
			let props: TurnPairCoreProperties;
			try {
				props = JSON.parse(node.content_json) as TurnPairCoreProperties;
			} catch {
				continue;
			}
			if (!props.high_signal) continue;

			const pair = pairByUserId.get(props.user_message_id);
			if (!pair) continue;

			const sources: SourceRef[] = [{ kind: "analysis_node", id: node.id }];
			const meta: EnrichMeta = {
				userText: pair.userText,
				assistantText: pair.assistantText,
				correctionText: props.correction_text,
				coreNodeId: node.id,
			};
			units.push({
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "message",
				anchorRef: props.user_message_id,
				meta: meta as unknown as Record<string, unknown>,
			});
		}
		return units;
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = (ctx.config.configJson as unknown as TurnPairLLMConfig) ?? DEFAULT_TURN_PAIR_LLM_CONFIG;
		const meta = unit.meta as unknown as EnrichMeta;

		const response = await ctx.llm({
			model: config.tier,
			system: ctx.prompts["classify"] ?? CLASSIFY_PROMPT,
			user: buildClassifyPrompt({
				userText: meta.userText,
				assistantText: meta.assistantText,
				correctionText: meta.correctionText,
			}),
			temperature: config.temperature,
			maxTokens: 500,
		});

		const properties: TurnPairLLMProperties = parseClassifyResponse(response.text);

		return {
			nodeKind: "classification",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "message",
			anchorRef: unit.anchorRef,
			modelUsed: response.model,
			costUsd: response.costUsd,
			tokensUsed: response.tokensUsed,
			durationMs: response.durationMs,
			edges: [
				{ toRefKind: REF_KINDS.MESSAGE, toRefId: unit.anchorRef, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
				{ toRefKind: REF_KINDS.ANALYSIS_NODE, toRefId: meta.coreNodeId, edgeKind: EDGE_KINDS.CONSUMES, ordinal: 1 },
				{ toRefKind: REF_KINDS.PROMPT_VERSION, toRefId: CLASSIFY_PROMPT_HASH, edgeKind: EDGE_KINDS.USES_PROMPT, ordinal: 2 },
			],
		};
	},
};
