/**
 * Analyzer Framework - Main entry point
 * Based on analyzer-design-c.md specification
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";

// Global LLM provider (can be overridden for testing)
let globalLLMProvider: ((request: LLMRequest) => Promise<LLMResponse>) | null = null;

export function setLLMProvider(provider: (request: LLMRequest) => Promise<LLMResponse>): void {
	globalLLMProvider = provider;
}

// ── Types ──

export type AnchorSpan = "pair" | "segment" | "full_session";
export type ImplementationKind = "deterministic" | "in_process_llm" | "pi_subagent";
export type NodeKind = "metric" | "classification" | "summary" | "proposal" | "error";
export type EdgeKind = "anchors" | "consumes" | "refines" | "uses_prompt" | "uses_config" | "produces";
export type RunStatus = "planned" | "running" | "ok" | "error" | "partial";
export type ProgressStatus = "ok" | "in_progress" | "error" | "needs_rerun";
export type ProposalStatus = "open" | "accepted" | "applied" | "rejected" | "duplicate";
export type ProposalSeverity = "friction" | "correction" | "waste" | "suggestion" | "insight";
export type TargetType = "agents_md" | "system_md" | "skill" | "extension_prompt" | "tool_output" | "repo_doc" | "config";

export interface AnalyzerDef { id: string; label: string; description?: string; anchorSpan: AnchorSpan; dependencies: string[]; createdAt: string; }
export interface AnalyzerVersion { analyzerId: string; versionId: string; implementationKind: ImplementationKind; codeRef?: string; createdAt: string; }
export interface PromptVersion { hash: string; fullHash: string; content: string; role?: string; createdAt: string; }
export interface AnalyzerConfig { id: string; analyzerId: string; configJson: Record<string, unknown>; configHash: string; label?: string; createdAt: string; }
export interface SourceRef { kind: "message" | "analysis_node" | "session"; id: string; }
export interface AnalysisUnit { sources: SourceRef[]; sourceSetHash: string; anchorKind: "message" | "pair" | "segment" | "session" | "analysis_node" | "none"; anchorRef?: string; meta?: Record<string, unknown>; }
export interface AnalysisEdge { toRefKind: string; toRefId: string; edgeKind: EdgeKind; ordinal?: number; }
export interface AnalysisResult { contentJson: Record<string, unknown>; nodeKind: NodeKind; anchorKind: string; anchorRef?: string; edges: AnalysisEdge[]; modelUsed?: string; costUsd?: number; tokensUsed?: number; durationMs?: number; }
export interface AnalyzerPlanContext { sessionId: string; messages: AnalysisMessage[]; allNodes: AnalysisNodeRow[]; ownNodes: AnalysisNodeRow[]; dependencyNodes: Record<string, AnalysisNodeRow[]>; progress: ProgressRow | null; db: unknown; }
export interface AnalyzerRunContext { 
	getMessage(id: string): AnalysisMessage | undefined; 
	getNode(id: string): AnalysisNodeRow | undefined; 
	getDependencyNodes(analyzerId: string): AnalysisNodeRow[]; 
	llm(request: LLMRequest): Promise<LLMResponse>; 
	run: RunRow; 
	config: AnalyzerConfig; 
	prompts: Record<string, string>; 
}
export interface LLMRequest { messages: Array<{ role: string; content: string }>; model?: string; json?: boolean; maxTokens?: number; temperature?: number; }
export interface LLMResponse { content: string; json?: Record<string, unknown>; model: string; usage?: { inputTokens?: number; outputTokens?: number; }; costUsd?: number; }
export interface AnalysisMessage { id: string; session_id: string; parent_id: string | null; timestamp: string | null; role: string; content_text: string | null; content_thinking: string | null; tool_calls: string | null; tool_results: string | null; }
export interface AnalysisNodeRow { id: string; session_id: string; analyzer_id: string; analyzer_version_id: string; config_id: string; run_id: string; node_kind: string; content_json: string; source_set_hash: string; input_hash: string; created_at: string; model_used: string | null; cost_usd: number; tokens_used: number; duration_ms: number | null; }
export interface ProgressRow { analyzer_id: string; analyzer_version_id: string; config_id: string; session_id: string; cursor_json: string | null; last_run_id: string | null; total_analyzed: number; status: ProgressStatus; error_message: string | null; updated_at: string; }
export interface RunRow { id: string; analyzer_id: string; analyzer_version_id: string; config_id: string; session_id: string; status: RunStatus; prompt_bundle_hash: string; started_at: string; finished_at: string | null; model_spec: string | null; cost_usd: number; tokens_used: number; nodes_produced: number; nodes_skipped: number; error_message: string | null; }
export interface Analyzer { def: AnalyzerDef; version: AnalyzerVersion; prompts: Record<string, PromptVersion>; defaultConfig: AnalyzerConfig; plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> | AnalysisUnit[]; analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> | AnalysisResult; }

// ── Input Hash Functions ──

export function computeSourceSetHash(sources: SourceRef[]): string {
	const sorted = [...sources].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
	return createHash("sha256").update(sorted.map(r => `${r.kind}:${r.id}`).join("|")).digest("hex").slice(0, 16);
}

export function computePromptBundleHash(promptHashes: string[]): string {
	return createHash("sha256").update([...promptHashes].sort().join("|")).digest("hex").slice(0, 16);
}

export function computeInputHash(analyzerId: string, versionId: string, configId: string, promptBundleHash: string, sourceSetHash: string): string {
	return createHash("sha256").update(`${analyzerId}|${versionId}|${configId}|${promptBundleHash}|${sourceSetHash}`).digest("hex").slice(0, 16);
}

// ── UUID v7 ──

function generateUUIDv7(): string {
	const timestamp = Date.now();
	const random = Math.floor(Math.random() * 0x100000000);
	const timeHex = timestamp.toString(16).padStart(12, "0");
	const randomHex = random.toString(16).padStart(8, "0");
	return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${randomHex.slice(0, 3)}-${randomHex.slice(3, 8)}-${randomHex.slice(8, 16)}`;
}

// ── Framework Class ──

export class AnalyzerFramework {
	private db: Database.Database;
	constructor(db: Database.Database) { this.db = db; }

	registerDef(analyzerId: string, label: string, description: string, anchorSpan: AnchorSpan, dependencies: string[] = []): void {
		this.db.prepare("INSERT OR IGNORE INTO analyzer_defs (id, label, description, anchor_span, dependencies, created_at) VALUES (?, ?, ?, ?, ?, ?)")
			.run(analyzerId, label, description, anchorSpan, JSON.stringify(dependencies), new Date().toISOString());
	}

	async run(analyzer: Analyzer, sessionId: string): Promise<{ runId: string; nodesProduced: number; nodesSkipped: number; costUsd: number }> {
		const config = analyzer.defaultConfig;
		const promptBundleHash = computePromptBundleHash(Object.values(analyzer.prompts).map(p => p.hash));
		const runId = generateUUIDv7();
		this.db.prepare("INSERT INTO analysis_runs (id, analyzer_id, analyzer_version_id, config_id, session_id, status, prompt_bundle_hash, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
			.run(runId, analyzer.def.id, analyzer.version.versionId, config.id, sessionId, "running", promptBundleHash, new Date().toISOString());
		const messages = this.db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY rowid ASC").all(sessionId) as AnalysisMessage[];
		const allNodes = this.db.prepare("SELECT * FROM analysis_nodes WHERE session_id = ?").all(sessionId) as AnalysisNodeRow[];
		const ownNodes = allNodes.filter(n => n.analyzer_id === analyzer.def.id);
		const dependencyNodes = analyzer.def.dependencies.reduce((acc, depId) => {
			acc[depId] = allNodes.filter(n => n.analyzer_id === depId);
			return acc;
		}, {} as Record<string, AnalysisNodeRow[]>);
		
		let nodesProduced = 0, nodesSkipped = 0;
		try {
			const units = await analyzer.plan({ sessionId, messages, allNodes, ownNodes, dependencyNodes, progress: null, db: this.db });
			for (const unit of units) {
				const inputHash = computeInputHash(analyzer.def.id, analyzer.version.versionId, config.id, promptBundleHash, unit.sourceSetHash);
				if (this.db.prepare("SELECT 1 FROM analysis_nodes WHERE input_hash = ?").get(inputHash)) { nodesSkipped++; continue; }
				const result = await analyzer.analyze(unit, { 
				getMessage: (id) => messages.find(m => m.id === id), 
				getNode: (id) => {
					const row = this.db.prepare("SELECT * FROM analysis_nodes WHERE id = ?").get(id);
					return row as AnalysisNodeRow | undefined;
				}, 
				getDependencyNodes: (analyzerId) => {
					const nodes = this.db.prepare("SELECT * FROM analysis_nodes WHERE session_id = ? AND analyzer_id = ?").all(sessionId, analyzerId);
					return nodes as AnalysisNodeRow[];
				}, 
				llm: async (req: LLMRequest) => {
					if (globalLLMProvider) return globalLLMProvider(req);
					const { callLLM } = await import("./llm.js");
					return callLLM(req);
				}, 
				run: { id: runId } as RunRow, 
				config, 
				prompts: Object.fromEntries(Object.entries(analyzer.prompts).map(([k, v]) => [k, v.content])) 
			});
				this.db.prepare("INSERT INTO analysis_nodes (id, session_id, analyzer_id, analyzer_version_id, config_id, run_id, node_kind, content_json, source_set_hash, input_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
					.run(generateUUIDv7(), sessionId, analyzer.def.id, analyzer.version.versionId, config.id, runId, result.nodeKind, JSON.stringify(result.contentJson), unit.sourceSetHash, inputHash, new Date().toISOString());
				nodesProduced++;
			}
			this.db.prepare("UPDATE analysis_runs SET status = 'ok', finished_at = ?, nodes_produced = ? WHERE id = ?").run(new Date().toISOString(), nodesProduced, runId);
			return { runId, nodesProduced, nodesSkipped, costUsd: 0 };
		} catch (error) {
			this.db.prepare("UPDATE analysis_runs SET status = 'error', finished_at = ?, error_message = ? WHERE id = ?").run(new Date().toISOString(), String(error), runId);
			throw error;
		}
	}
}
