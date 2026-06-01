import type { Analyzer, AnalyzerDef, AnalyzerVersion, AnalysisUnit, AnalysisResult, AnalyzerConfig, AnalyzerPlanContext, AnalyzerRunContext, SourceRef, EdgeKind } from "../analyze.js";

const defaultConfig: AnalyzerConfig = {
	id: "turn-pair-core-config-v1",
	analyzerId: "turn-pair-core",
	configJson: { friction_threshold: 0.5, correction_patterns_enabled: true },
	configHash: "default-config-hash",
	label: "default",
	createdAt: new Date().toISOString(),
};

const CORRECTION_PATTERNS = {
	explicit: [/correction[\s:]+(.+)/i, /(?:actually|wait)[\s,]+(?:use|take|\.)/i],
	implicit: [/(?:I (?:meant|said)|as I (?:mentioned|said))/i],
	repetition: [/(?:same|again|retry|re-?run)/i],
};

const DEF: AnalyzerDef = {
	id: "turn-pair-core",
	label: "Per-Turn Deterministic Metrics",
	description: "Extracts deterministic metrics from user-assistant turn pairs",
	anchorSpan: "pair",
	dependencies: [],
	createdAt: new Date(2025, 0, 1).toISOString(),
};

const VERSION: AnalyzerVersion = {
	analyzerId: "turn-pair-core",
	versionId: "v1.0.0",
	implementationKind: "deterministic",
	codeRef: "src/commands/turn-pair-core-analyzer.ts",
	createdAt: new Date(2025, 0, 1).toISOString(),
};

function detectCorrections(text: string | null): { detected: boolean; patterns: string[]; type: "explicit" | "implicit" | "repetition" | null; correctionText: string | null } {
	if (!text) return { detected: false, patterns: [], type: null, correctionText: null };
	const patterns: string[] = []; let type: "explicit" | "implicit" | "repetition" | null = null; let correctionText: string | null = null;
	for (const re of CORRECTION_PATTERNS.explicit) { const match = text.match(re); if (match) { patterns.push("explicit"); type = "explicit"; correctionText = match[1] ?? null; break; } }
	if (!type) { for (const re of CORRECTION_PATTERNS.implicit) { if (re.test(text)) { patterns.push("implicit"); type = "implicit"; break; } } }
	if (!type) { for (const re of CORRECTION_PATTERNS.repetition) { if (re.test(text)) { patterns.push("repetition"); type = "repetition"; break; } } }
	return { detected: patterns.length > 0, patterns, type, correctionText };
}

interface ToolCallParsed { name: string; arguments: Record<string, unknown>; }
function parseToolCalls(toolCallsJson: string | null): ToolCallParsed[] | null {
	if (!toolCallsJson) return null; try { return JSON.parse(toolCallsJson); } catch { return null; }
}

export const turnPairCoreAnalyzer: Analyzer = {
	def: DEF,
	version: VERSION,
	prompts: {},
	defaultConfig,
	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		const units: AnalysisUnit[] = [];
		const messages = ctx.messages;
		for (let i = 0; i < messages.length; i++) {
			const msgI = messages[i];
			if (!msgI || msgI.role !== "user") continue;
			let j = i + 1;
			while (j < messages.length && messages[j]!.role !== "assistant") j++;
			const msgJ = messages[j];
			if (!msgJ || msgJ.role !== "assistant") continue;
			const sources: SourceRef[] = [];
			for (let k = i; k <= j; k++) { sources.push({ kind: "message", id: messages[k]!.id }); }
			units.push({ sources, sourceSetHash: computeSourceSetHash(sources), anchorKind: "pair", anchorRef: msgI.id, meta: { userIndex: i, assistantIndex: j } });
		}
		return units;
	},
	analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): AnalysisResult {
		const sources = unit.sources;
		const userMsg = sources.length > 0 ? ctx.getMessage(sources[0]!.id) : undefined;
		const assistantMsg = sources.length > 1 ? ctx.getMessage(sources[1]!.id) : undefined;
		const userMsgLength = userMsg?.content_text?.length ?? 0;
		const assistantMsgLength = assistantMsg?.content_text?.length ?? 0;
		const hasThinking = assistantMsg?.content_thinking !== null;
		const thinkingLength = assistantMsg?.content_thinking?.length ?? 0;
		const toolCalls = parseToolCalls(assistantMsg?.tool_calls ?? null) ?? [];
		const correctionInfo = detectCorrections(userMsg?.content_text ?? null);
		let frictionScore = 0;
		if (correctionInfo.detected) frictionScore += 0.4;
		if (toolCalls.length > 5) frictionScore += 0.2;
		if (assistantMsgLength > 5000) frictionScore += 0.1;
		if (hasThinking && thinkingLength > 1000) frictionScore += 0.1;
		const contentJson = {
			user_msg_length: userMsgLength, assistant_msg_length: assistantMsgLength, has_thinking: hasThinking,
			thinking_length: thinkingLength, correction_detected: correctionInfo.detected, correction_patterns: correctionInfo.patterns,
			correction_type: correctionInfo.type, correction_text: correctionInfo.correctionText,
			tool_call_count: toolCalls.length, tool_names: toolCalls.map(t => t.name), tool_failure_count: 0, tool_failure_details: [],
			tool_waste_bytes: 0, retry_detected: false, elapsed_seconds: null, friction_score: Math.min(1.0, frictionScore),
			model: null, stop_reason: null, usage_input_tokens: null, usage_output_tokens: null,
			is_compaction_boundary: userMsg?.role === "compactionSummary" || assistantMsg?.role === "compactionSummary",
		};
		const edges = sources.map((s, i) => ({ toRefKind: "message" as const, toRefId: s.id, edgeKind: "anchors" as EdgeKind, ordinal: i }));
		return { contentJson, nodeKind: "metric", anchorKind: "pair", anchorRef: unit.anchorRef, edges };
	},
};

export function computeSourceSetHash(sources: SourceRef[]): string {
	return sources.map(r => `${r.kind}:${r.id}`).sort().join("|");
}

export default turnPairCoreAnalyzer;