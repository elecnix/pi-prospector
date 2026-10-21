/**
 * assistant-cognition — detects confusion, indecision, surprise, and apology in
 * the assistant's own words during a turn.
 *
 * Depends on turn-pair-core (turn construction). A turn is analysed when its
 * aggregated thinking trace is substantive (>= config.minThinkingLength) — a
 * token "Okay, let me..." carries no cognitive signal worth a model call — or
 * when its response carries a deterministic apology match, which is the second
 * way in for an apology (issue #318): an apology lives in the response text,
 * and a model that never reasoned would otherwise never be read. The analyzer
 * reads the turn's THINKING TRACE and RESPONSE TEXT as separately labeled
 * inputs plus the anchoring user message, and emits one `classification` node
 * per analysed turn carrying four signal arrays:
 *
 *   - confusion   {level, rationale}   inferred across the turn; no quote.
 *   - indecision  {level, rationale}   structural flip-flopping; no quote.
 *   - surprise    {quote, severity, rationale} — the quote is validated as an
 *                 exact substring of the thinking or response text before it is
 *                 stored, so every surprise traces back to verbatim evidence.
 *   - apology     {quote, severity, rationale} — the assistant conceding that it
 *                 was wrong; the quote is validated as an exact substring of the
 *                 response text, exactly as a surprise quote is.
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
import { matchApologyCandidates } from "../../speech-acts.js";
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
import {
	COGNITION_DECISION_HASH,
	COGNITION_DECISION_QUESTIONS,
	QUOTE_PROMPT,
	QUOTE_PROMPT_HASH,
	QUOTE_TOOL,
	buildCognitionDecisionState,
	parseCognitionDecision,
} from "./decision.js";
import { decisionIdentity } from "../../decision-model.js";
import { DEFAULT_ASSISTANT_COGNITION_CONFIG, type AssistantCognitionConfig } from "./config.js";

export const ASSISTANT_COGNITION_DEF: AnalyzerDef = {
	id: "assistant-cognition",
	label: "Assistant Cognition (LLM)",
	description:
		"Detects confusion, indecision, surprise, and apology in the assistant's own thinking trace and response per turn, with graded intensity and verbatim-validated surprise and apology quotes.",
	anchorSpan: "pair",
	dependencies: [TURN_PAIR_CORE_DEF.id],
	outputSchema: AssistantCognitionProperties,
};

export const ASSISTANT_COGNITION_VERSION: AnalyzerVersion = {
	analyzerId: ASSISTANT_COGNITION_DEF.id,
	major: 1,
	// 1.1 (issue #318): the **apology** signal — the assistant conceding that it
	// was wrong, carrying a quote validated verbatim against the response text
	// exactly as a surprise quote is. The gate gains a second way in: a turn whose
	// response carries a deterministic apology match is analysed even when its
	// thinking trace is empty, because an apology lives in the response. The
	// prompt gained a fourth signal array and the node content gained a fourth
	// field, so the version moves and prior verdicts stay reachable through
	// `revises`.
	minor: 1,
	implementationKind: "in_process_llm",
	codeRef: "src/analyze/analyzers/assistant-cognition/index.ts",
};

const PROMPTS: Record<string, PromptVersion> = {
	cognition: { hash: COGNITION_PROMPT_HASH, content: COGNITION_PROMPT, role: "classify" },
	quote_surprise: { hash: QUOTE_PROMPT_HASH, content: QUOTE_PROMPT, role: "extract" },
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
		// The decision path still extracts surprise quotes on `tier`, so both count.
		if (cfg.decisionModel) {
			return [decisionIdentity(cfg.decisionModel, COGNITION_DECISION_HASH), resolveModelSpec(cfg.tier, modelTiers)];
		}
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

		// Gate: a turn is analysed when its thinking text is non-empty above the
		// minimum length, OR when its response carries a deterministic apology
		// match (issue #318). The second way in matters because an apology lives
		// in the response text: a model that never reasoned is never analysed
		// through the thinking gate, yet an apology is exactly the turn where the
		// assistant's own words admit a mistake. The match admits the turn to
		// scrutiny — what is stored is still the model's graded apology with a
		// quote validated against the response.
		//
		// Unlike turn-pair-llm this is not ranked or capped — cognition is cheap-tier
		// and the gate alone bounds volume to turns where the agent actually reasoned
		// or conceded.
		const units: AnalysisUnit[] = [];
		for (const pair of pairs) {
			const hasThinking = pair.thinkingText.trim().length >= config.minThinkingLength;
			const apologised = matchApologyCandidates(pair.assistantText).length > 0;
			if (!hasThinking && !apologised) continue;
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
		if (config.decisionModel) return analyzeWithDecisionModel(unit, meta, grounds, config, config.decisionModel, ctx);
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
		let parsed: Pick<AssistantCognitionProperties, "confusion" | "indecision" | "surprise" | "apology">;
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
				parsed = { confusion: [], indecision: [], surprise: [], apology: [] };
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

/**
 * One decision request grades the turn (#338); a generative call runs only when
 * the turn shows surprise, to copy the quote that grounds it.
 */
async function analyzeWithDecisionModel(
	unit: AnalysisUnit,
	meta: CognitionMeta,
	grounds: QuoteGrounds,
	config: AssistantCognitionConfig,
	model: string,
	ctx: AnalyzerRunContext,
): Promise<AnalysisResult> {
	if (!ctx.decide) {
		throw new Error(`assistant-cognition is configured with decision model '${model}', but this run has no decision-model client.`);
	}
	const input = { userText: meta.userText, thinkingText: meta.thinkingText, assistantText: meta.assistantText };
	const decision = await ctx.decide({ model, state: buildCognitionDecisionState(input), questions: COGNITION_DECISION_QUESTIONS });
	const parsed = parseCognitionDecision(decision);

	let costUsd = decision.costUsd;
	let inputTokens = decision.inputTokens;
	let cachedInputTokens = 0;
	let outputTokens = decision.outputTokens;
	const surprise: AssistantCognitionProperties["surprise"] = [];
	const edges: AnalysisResult["edges"] = [
		{ toRefKind: REF_KINDS.MESSAGE, toRefId: unit.anchorRef, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
		{ toRefKind: REF_KINDS.ANALYSIS_NODE, toRefId: meta.coreOutputKey, edgeKind: EDGE_KINDS.CONSUMES, ordinal: 1 },
	];
	if (parsed.surpriseSeverity) {
		const response = await ctx.llm({
			model: resolveModelSpec(config.tier, ctx.modelTiers),
			system: ctx.prompts["quote_surprise"] ?? QUOTE_PROMPT,
			user: buildCognitionPrompt(input),
			temperature: config.temperature,
			maxTokens: 300,
			tool: QUOTE_TOOL,
		});
		costUsd += response.costUsd;
		inputTokens += response.inputTokens ?? 0;
		cachedInputTokens += response.cachedInputTokens ?? 0;
		outputTokens += response.outputTokens ?? 0;
		const quote = (response.structured as { quote?: unknown } | undefined)?.quote;
		// Same rule as the generative path: a quote that is not verbatim in the turn never enters the graph.
		if (typeof quote === "string" && quote.length > 0 && (grounds.thinkingText.includes(quote) || grounds.assistantText.includes(quote))) {
			surprise.push({ quote, severity: parsed.surpriseSeverity, rationale: "" });
		}
		edges.push({ toRefKind: REF_KINDS.PROMPT_VERSION, toRefId: QUOTE_PROMPT_HASH, edgeKind: EDGE_KINDS.USES_PROMPT, ordinal: 2 });
	}

	const properties: AssistantCognitionProperties = {
		confusion: parsed.confusion,
		indecision: parsed.indecision,
		surprise,
		// The decision path grades the turn, it does not read the assistant's
		// words for a concession, so it reports no apology. An empty array means
		// "not reported", never "no apology happened".
		apology: [],
		probabilities: parsed.probabilities,
		user_message_id: unit.anchorRef,
	};
	return {
		nodeKind: "classification",
		contentJson: properties as unknown as Record<string, unknown>,
		anchorKind: "message",
		anchorRef: unit.anchorRef,
		modelUsed: decision.model,
		costUsd,
		tokensUsed: inputTokens + cachedInputTokens + outputTokens,
		inputTokens,
		cachedInputTokens,
		outputTokens,
		durationMs: decision.durationMs,
		edges,
	};
}
