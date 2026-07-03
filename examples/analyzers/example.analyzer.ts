/**
 * Example custom analyzer — copy this into ~/.pi/agent/prospector/analyzers/
 * (rename to `<something>.analyzer.ts`), then in an interactive Pi session run:
 *
 *   /reload
 *   /prospect-analyzers list                                   ← confirm it loaded
 *   /prospect-analyze --analyzer example-tool-usage --session <id>
 *
 * A deterministic, session-level analyzer that counts how many times each tool
 * was called. No model is used.
 *
 * This template is intentionally **zero-import** so it loads from anywhere. The
 * loader validates the shape and fills `defaultConfig.configHash` for you. If you
 * author inside a pi-prospector checkout and want eager validation + editor
 * types, you can instead:
 *
 *   import { defineAnalyzer } from "../../src/analyze/authoring.js";
 *   import type { AnalyzerPlanContext, AnalyzerRunContext } from "../../src/analyze/types.js";
 *   export default defineAnalyzer({ ... });
 *
 * The `plan()`/`analyze()` context shapes are documented in src/analyze/types.ts.
 */

const analyzer = {
	def: {
		id: "example-tool-usage",
		label: "Example — Tool Usage",
		description: "Counts how many times each tool was called in a session.",
		anchorSpan: "full_session" as const,
		dependencies: [] as string[],
	},
	version: {
		analyzerId: "example-tool-usage",
		major: 1,
		minor: 0,
		implementationKind: "deterministic" as const,
	},
	prompts: {},
	defaultConfig: {
		id: "",
		analyzerId: "example-tool-usage",
		configHash: "", // filled by the loader from configJson
		configJson: {},
		label: "default",
	},

	// One unit per session, anchored to the session itself. `sourceSetHash` is any
	// stable string identifying this unit's inputs — reuse it and prior nodes are
	// recognised as the same logical unit.
	plan(ctx: { sessionId: string; messages: unknown[] }) {
		if (ctx.messages.length === 0) return [];
		return [
			{
				sources: [{ kind: "session" as const, id: ctx.sessionId }],
				sourceSetHash: `example-tool-usage:${ctx.sessionId}`,
				anchorKind: "session" as const,
				anchorRef: ctx.sessionId,
			},
		];
	},

	// Produce a single `metric` node with a per-tool call count.
	analyze(
		_unit: unknown,
		ctx: { sessionId: string; getSessionMessages: (id: string) => Array<{ role: string; tool_calls: string | null }> },
	) {
		const counts: Record<string, number> = {};
		for (const m of ctx.getSessionMessages(ctx.sessionId)) {
			if (m.role !== "assistant" || !m.tool_calls) continue;
			try {
				const calls = JSON.parse(m.tool_calls) as Array<{ name?: unknown }>;
				for (const c of calls) {
					const name = typeof c.name === "string" ? c.name : "unknown";
					counts[name] = (counts[name] ?? 0) + 1;
				}
			} catch {
				// ignore malformed tool_calls
			}
		}
		const total = Object.values(counts).reduce((a, b) => a + b, 0);
		return {
			nodeKind: "metric" as const,
			contentJson: { total_tool_calls: total, by_tool: counts },
			anchorKind: "session" as const,
			anchorRef: ctx.sessionId,
			edges: [],
		};
	},
};

export default analyzer;
