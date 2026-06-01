/**
 * LLM-based Turn-Pair Analyzer
 * Enriches turn-pair-core results with sentiment and friction analysis
 */

import type { Analyzer, AnalyzerDef, AnalyzerVersion, AnalysisUnit, AnalysisResult, AnalyzerConfig, AnalyzerPlanContext, AnalyzerRunContext, AnalysisNodeRow, EdgeKind } from "./analyze.js";

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
	codeRef: "src/analyze-llm.ts",
	createdAt: new Date(2025, 0, 1).toISOString(),
};

export const turnPairLLMAnalyzer: Analyzer = {
	def: DEF,
	version: VERSION,
	prompts: {},
	defaultConfig,

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		const units: AnalysisUnit[] = [];
		const coreNodes = ctx.dependencyNodes["turn-pair-core"] || [];
		
		for (const node of coreNodes) {
			const props = JSON.parse(node.content_json as string);
			if (props.correction_detected || (props.friction_score || 0) >= 0.4) {
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
		const sourceNode = unit.sources[0] ? ctx.getNode(unit.sources[0].id) : undefined;
		const sourceProps = sourceNode ? JSON.parse((sourceNode as AnalysisNodeRow).content_json) : {};
		
		// LLM response placeholder (would call actual LLM)
		const llmResponse = {
			sentiment: "neutral" as const,
			frustration_level: 0,
			correction_type_llm: null as "explicit" | "implicit" | "repetition" | null,
			friction_cause: null as string | null,
			friction_summary: null as string | null,
			user_intent: "",
			quality_score: 3,
		};

		return {
			contentJson: {
				...sourceProps,
				...llmResponse,
				llm_enriched: true,
			},
			nodeKind: "classification",
			anchorKind: "analysis_node",
			anchorRef: unit.anchorRef,
			edges: [
				{ toRefKind: "analysis_node", toRefId: unit.sources[0]?.id || "", edgeKind: "refines" as EdgeKind },
				{ toRefKind: "analysis_node", toRefId: unit.sources[0]?.id || "", edgeKind: "consumes" as EdgeKind },
			],
		};
	},
};

export default turnPairLLMAnalyzer;