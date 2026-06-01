/**
 * Session Overview Analyzer
 * LLM summary with proposals for the entire session
 */

import type { Analyzer, AnalyzerDef, AnalyzerVersion, AnalysisUnit, AnalysisResult, AnalyzerConfig, AnalyzerPlanContext, AnalyzerRunContext, AnalysisNodeRow, EdgeKind } from "../analyze.js";

const defaultConfig: AnalyzerConfig = {
	id: "session-overview-config-v1",
	analyzerId: "session-overview",
	configJson: { model_tier: "mid" },
	configHash: "default-overview-config-hash",
	label: "default",
	createdAt: new Date().toISOString(),
};

const DEF: AnalyzerDef = {
	id: "session-overview",
	label: "Session-Level Analysis & Proposals",
	description: "Session summary with proposals",
	anchorSpan: "full_session",
	dependencies: ["turn-pair-core", "turn-pair-llm"],
	createdAt: new Date(2025, 0, 1).toISOString(),
};

const VERSION: AnalyzerVersion = {
	analyzerId: "session-overview",
	versionId: "v1.0.0",
	implementationKind: "in_process_llm",
	codeRef: "src/commands/session-overview-analyzer.ts",
	createdAt: new Date(2025, 0, 1).toISOString(),
};

const SUMMARY_PROMPT = `Summarize this session and extract improvement proposals.

Return JSON with:
{
  "session_summary": "2-3 sentence summary",
  "key_friction_points": [{"description": "...", "severity": "high|medium|low"}],
  "improvement_proposals": [{"target_type": "skill|extension_prompt|tool_output", "target_path": "...", "title": "...", "summary": "...", "severity": "friction|correction|waste|suggestion|insight"}]
}`;

export const sessionOverviewAnalyzer: Analyzer = {
	def: DEF,
	version: VERSION,
	prompts: { 
		summary: { 
			hash: "summary-v1", 
			fullHash: "summary-v1-full", 
			content: SUMMARY_PROMPT, 
			createdAt: new Date().toISOString() 
		} 
	},
	defaultConfig,

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		// Check if we already have a summary
		const existing = ctx.ownNodes && ctx.ownNodes.length > 0;
		if (existing) return [];

		const sourceNodes: { kind: "analysis_node"; id: string }[] = [];
		
		// Collect source nodes from dependencies
		for (const depId of this.def.dependencies) {
			const nodes = ctx.dependencyNodes[depId] || [];
			for (const node of nodes) {
				sourceNodes.push({ kind: "analysis_node", id: node.id });
			}
		}

		return [{
			sources: sourceNodes,
			sourceSetHash: `session:${ctx.sessionId}`,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
		}];
	},

	async analyze(_unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const summaryNodes = ctx.getDependencyNodes("turn-pair-core");
		const llmNodes = ctx.getDependencyNodes("turn-pair-llm");
		
		let sessionSummary = "Session analyzed";
		let proposals: Array<{ target_type: string; target_path: string | null; title: string; summary: string; severity: string }> = [];
		
		if (process.env.OPENROUTER_API_KEY && summaryNodes.length > 0) {
			try {
				const response = await ctx.llm({
					messages: [
						{ role: "system", content: SUMMARY_PROMPT },
						{ role: "user", content: `Analyze ${summaryNodes.length} turn pairs and summarize the session` },
					],
					model: "poolside/laguna-m.1:free",
					json: true,
				});
				
				if (response.json && typeof response.json === "object") {
					const json = response.json as Record<string, unknown>;
					sessionSummary = typeof json.session_summary === "string" ? json.session_summary : sessionSummary;
					proposals = Array.isArray(json.improvement_proposals) ? json.improvement_proposals : [];
				}
			} catch (e) {
				console.error("LLM call failed:", e);
			}
		}

		const edges = [...summaryNodes, ...llmNodes].map(n => ({ 
			toRefKind: "analysis_node" as const, 
			toRefId: n.id, 
			edgeKind: "consumes" as EdgeKind 
		}));

		return {
			contentJson: {
				session_summary: sessionSummary,
				total_pairs: summaryNodes.length,
				proposals_generated: proposals.length,
				high_friction_count: summaryNodes.filter(n => {
					const c = JSON.parse(n.content_json);
					return c.friction_score > 0.3 || c.correction_detected;
				}).length,
			},
			nodeKind: "summary",
			anchorKind: "session",
			anchorRef: ctx.run.session_id,
			edges,
		};
	},
};

export default sessionOverviewAnalyzer;
