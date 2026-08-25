/**
 * assistant-cognition — detects confusion, indecision, and surprise in the
 * assistant's own words during a turn.
 *
 * Depends on turn-pair-core (turn construction). A turn is analysed when its
 * aggregated thinking trace is substantive (>= config.minThinkingLength): a
 * token "Okay, let me..." carries no cognitive signal worth a model call. The
 * analyzer reads the turn's THINKING TRACE and RESPONSE TEXT as separately
 * labeled inputs plus the anchoring user message, and emits one `classification`
 * node per analysed turn carrying three signal arrays:
 *
 *   - confusion   {level, rationale}   inferred across the turn; no quote.
 *   - indecision  {level, rationale}   structural flip-flopping; no quote.
 *   - surprise    {quote, severity, rationale} — the quote is validated as an
 *                 exact substring of the thinking or response text before it is
 *                 stored, so every surprise traces back to verbatim evidence.
 *
 * Robustness: native structured output via a forced tool call, with one retry;
 * a second failure records an abstention (empty arrays are valid analysis).
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
import { resolveModelSpec } from "../../model-tiers.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { TURN_PAIR_CORE_DEF, type TurnPairCoreProperties } from "../turn-pair-core/index.js";
import {
	COGNITION_PROMPT,
	COGNITION_PROMPT_HASH,
	COGNITION_TOOL,
	buildCognitionPrompt,
	parseCognitionObject,
	parseCognitionResponse,
	AssistantCognitionProperties,
	type QuoteGrounds,
} from "./prompt.js";
import { DEFAULT_ASSISTANT_COGNITION_CONFIG, type AssistantCognitionConfig } from "./config.js";

export const ASSISTANT_COGNITION_DEF: AnalyzerDef = {
	id: "assistant-cognition",
	label: "Assistant Cognition (LLM)",
	description:
		"Detects confusion, indecision, and surprise in the assistant's own thinking trace and response per turn, with graded intensity and verbatim-validated surprise quotes.",
	anchorSpan: "pair",
	dependencies: [TURN_PAIR_CORE_DEF.id],
	outputSchema: AssistantCognitionProperties,
};

export const ASSISTANT_COGNITION_VERSION: AnalyzerVersion = {
	analyzerId: ASSISTANT_COGNITION_DEF.id,
	major: 1,
	minor: 0,
	implementationKind: "in_process_llm",
	codeRef: "src/analyze/analyzers/assistant-cognition/index.ts",
};

const PROMPTS: Record<string, PromptVersion> = {
	cognition: { hash: COGNITION_PROMPT_HASH, content: COGNITION_PROMPT, role: "classify" },
};

interface CognitionMeta {
	userText: string;
	thinkingText: string;
	assistantText: string;
	coreOutputKey: string;
}

export const assistantCognitionAnalyzer: Analyzer = {
	def: ASSISTANT_COGNITION_DEF,
	version: ASSISTANT_COGNITION_VERSION,
	prompts: PROMPTS,
	defaultConfig: {
		id: "",
		analyzerId: ASSISTANT_COGNITION_DEF.id,
		configHash: computeConfigHash(DEFAULT_ASSISTANT_COGNITION_CONFIG),
		configJson: DEFAULT_ASSISTANT_COGNITION_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	modelsForIdentity(config, modelTiers): string[] {
		const cfg = (config as unknown as AssistantCognitionConfig) ?? DEFAULT_ASSISTANT_COGNITION_CONFIG;
		return [resolveModelSpec(cfg.tier, modelTiers)];
	},

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		const coreNodes = ctx.dependencyNodes[TURN_PAIR_CORE_DEF.id] ?? [];
		const pairs = await ctx.getTurnPairs(ctx.sessionId);
		const pairByUserId = new Map(pairs.map((p) => [p.userMessageId, p]));
		const config = (ctx.config as unknown as AssistantCognitionConfig) ?? DEFAULT_ASSISTANT_COGNITION_CONFIG;

		// Core node per turn (by its anchoring user message id), for the consumes edge.
		const coreKeyByUserId = new Map<string, string>();
		for (const node of coreNodes) {
			let props: TurnPairCoreProperties;
			try {
				props = JSON.parse(node.content_json) as TurnPairCoreProperties;
			} catch {
				continue;
			}
			if (!coreKeyByUserId.has(props.user_message_id)) {
				coreKeyByUserId.set(props.user_message_id, node.output_key);
			}
		}

		// Gate: any turn whose thinking text is non-empty above the minimum length.
		// Unlike turn-pair-llm this is not ranked or capped — cognition is cheap-tier
		// and the gate alone bounds volume to turns where the agent actually reasoned.
		const units: AnalysisUnit[] = [];
		for (const pair of pairs) {
			if (pair.thinkingText.trim().length < config.minThinkingLength) continue;
			const coreOutputKey = coreKeyByUserId.get(pair.userMessageId);
			if (!coreOutputKey) continue;
			const sources: SourceRef[] = [{ kind: "analysis_node", id: coreOutputKey }];
			const meta: CognitionMeta = {
				userText: pair.userText,
				thinkingText: pair.thinkingText,
				assistantText: pair.assistantText,
				coreOutputKey,
			};
			units.push({
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "message",
				anchorRef: pair.userMessageId,
				meta: meta as unknown as Record<string, unknown>,
			});
		}
		return units;
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = (ctx.config.configJson as unknown as AssistantCognitionConfig) ?? DEFAULT_ASSISTANT_COGNITION_CONFIG;
		const meta = unit.meta as unknown as CognitionMeta;
		const grounds: QuoteGrounds = { thinkingText: meta.thinkingText, assistantText: meta.assistantText };
		const request = {
			model: resolveModelSpec(config.tier, ctx.modelTiers),
			system: ctx.prompts["cognition"] ?? COGNITION_PROMPT,
			user: buildCognitionPrompt({
				userText: meta.userText,
				thinkingText: meta.thinkingText,
				assistantText: meta.assistantText,
			}),
			temperature: config.temperature,
			maxTokens: 700,
			tool: COGNITION_TOOL,
		};

		// Two attempts, then abstain. A parse failure on both attempts records an
		// empty-signal classification rather than an error node: absence of evidence
		// here is a legitimate conclusion, and it keeps the unit from being retried
		// forever by later fills.
		let parsed: Pick<AssistantCognitionProperties, "confusion" | "indecision" | "surprise">;
		let response = await ctx.llm(request);
		try {
			parsed = response.structured
				? parseCognitionObject(response.structured as Record<string, unknown>, grounds)
				: parseCognitionResponse(response.text, grounds);
		} catch {
			response = await ctx.llm(request);
			try {
				parsed = response.structured
					? parseCognitionObject(response.structured as Record<string, unknown>, grounds)
					: parseCognitionResponse(response.text, grounds);
			} catch {
				parsed = { confusion: [], indecision: [], surprise: [] };
			}
		}

		const properties: AssistantCognitionProperties = {
			...parsed,
			user_message_id: unit.anchorRef,
		};

		return {
			nodeKind: "classification",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "message",
			anchorRef: unit.anchorRef,
			modelUsed: response.model,
			costUsd: response.costUsd,
			tokensUsed: response.tokensUsed,
			inputTokens: response.inputTokens,
			cachedInputTokens: response.cachedInputTokens,
			outputTokens: response.outputTokens,
			durationMs: response.durationMs,
			edges: [
				{ toRefKind: REF_KINDS.MESSAGE, toRefId: unit.anchorRef, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
				{ toRefKind: REF_KINDS.ANALYSIS_NODE, toRefId: meta.coreOutputKey, edgeKind: EDGE_KINDS.CONSUMES, ordinal: 1 },
				{ toRefKind: REF_KINDS.PROMPT_VERSION, toRefId: COGNITION_PROMPT_HASH, edgeKind: EDGE_KINDS.USES_PROMPT, ordinal: 2 },
			],
		};
	},
};
