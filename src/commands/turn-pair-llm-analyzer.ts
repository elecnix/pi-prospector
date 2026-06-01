/**
 * LLM-based Turn-Pair Analyzer
 * Enriches turn-pair-core results with sentiment and friction analysis
 */

import type { Analyzer, AnalyzerDef, AnalyzerVersion, AnalysisUnit, AnalysisResult, AnalyzerConfig, AnalyzerPlanContext, AnalyzerRunContext, AnalysisNodeRow, EdgeKind } from "../analyze.js";

const defaultConfig: AnalyzerConfig = {
	id: "turn-pair-llm-config-v1",
	analyzerId: "turn-pair-llm",
	configJson: { model_tier: "mid", friction_threshold: 0.4 },
	configHash: "default-llm-config-hash",
	label: "default",
	createdAt: new Date().toISOString(),
};

const DEF: AnalyzerDef = {
	id: "turn-pair-llm",
	label: "Per-Turn LLM Sentiment & Friction",
	description: "LLM enrichment for high-signal turn pairs",
	anchorSpan: "pair",
	dependencies: ["turn-pair-core"],
	createdAt: new Date(2025, 0, 1).toISOString(),
};

const VERSION: AnalyzerVersion = {
	analyzerId: "turn-pair-llm",
	versionId: "v1.0.0",
	implementationKind: "in_process_llm",
	codeRef: "src/commands/turn-pair-llm-analyzer.ts",
	createdAt: new Date(2025, 0, 1).toISOString(),
};

const ANALYSIS_PROMPT = `Analyze this user-assistant turn pair for sentiment and friction signals.

User message: {user_text}
Assistant message: {assistant_text}

Return JSON with:
- sentiment: "positive" | "neutral" | "negative" | "frustrated"
- frustration_level: 0-10
- correction_type_llm: "explicit" | "implicit" | "repetition" | null
- friction_cause: brief description or null
- friction_summary: 1-2 sentence summary or null
- user_intent: what the user was trying to accomplish
- quality_score: 1-5`;

type LLMAnalysisResponse = {
	sentiment: "positive" | "neutral" | "negative" | "frustrated";
	frustration_level: number;
	correction_type_llm: "explicit" | "implicit" | "repetition" | null;
	friction_cause: string | null;
	friction_summary: string | null;
	user_intent: string;
	quality_score: number;
};

export const turnPairLLMAnalyzer: Analyzer = {
	def: DEF,
	version: VERSION,
	prompts: { 
		analysis: { 
			hash: "llm-analysis-v1", 
			fullHash: "llm-analysis-v1-full", 
			content: ANALYSIS_PROMPT, 
			createdAt: new Date().toISOString() 
		} 
	},
	defaultConfig,

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		const units: AnalysisUnit[] = [];
		const coreNodes = ctx.dependencyNodes["turn-pair-core"] || [];
		
		for (const node of coreNodes) {
			const props = JSON.parse(node.content_json as string);
			// Only process pairs with corrections or high friction
			if (props.correction_detected || (props.friction_score || 0) >= 0.3) {
				units.push({
					sources: [{ kind: "analysis_node", id: node.id }],
					sourceSetHash: node.id,
					anchorKind: "analysis_node",
					anchorRef: node.id,
					meta: { deterministicNodeId: node.id },
				});
			}
		}
		return units;
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const sourceNode = ctx.getNode(unit.sources[0]?.id || "");
		const sourceProps = sourceNode ? JSON.parse((sourceNode as AnalysisNodeRow).content_json) : {};
		
		// Use stub if no API key
		const apiKey = process.env.OPENROUTER_API_KEY;
		
		let enrichedData: Record<string, unknown> = { llm_enriched: false };
		
		if (apiKey && sourceNode) {
			try {
				const userText = sourceProps.user_msg_text || sourceProps.content_text || "";
				const assistantText = sourceProps.assistant_msg_text || "";
				const response = await ctx.llm({
					messages: [
						{ role: "system", content: ANALYSIS_PROMPT.replace("{user_text}", userText.slice(0, 500)).replace("{assistant_text}", assistantText.slice(0, 500)) },
					],
					model: "poolside/laguna-m.1:free",
					json: true,
				});
				const json = response.json as LLMAnalysisResponse | undefined;
				if (json) {
					enrichedData = {
						sentiment: json.sentiment || "neutral",
						frustration_level: json.frustration_level || 3,
						correction_type_llm: json.correction_type_llm || null,
						friction_cause: json.friction_cause || null,
						friction_summary: json.friction_summary || null,
						user_intent: json.user_intent || "",
						quality_score: json.quality_score || 3,
						llm_enriched: true,
					};
				}
			} catch (e) {
				console.error("LLM call failed:", e);
			}
		}

		return {
			contentJson: { ...sourceProps, ...enrichedData },
			nodeKind: "classification",
			anchorKind: "analysis_node",
			anchorRef: unit.anchorRef,
			edges: [
				{ toRefKind: "analysis_node", toRefId: unit.sources[0]?.id || "", edgeKind: "refines" as EdgeKind },
			],
		};
	},
};

export default turnPairLLMAnalyzer;
