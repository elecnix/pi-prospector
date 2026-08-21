/**
 * token-units — prices a session in MITE, and renders the two reports.
 *
 * The unit and why it exists: [`config.ts`](./config.ts).
 * The arithmetic and the de-duplication crux: [`fold.ts`](./fold.ts).
 * The join with request-classes: [`leaves.ts`](./leaves.ts).
 *
 * This analyzer is the first user of the `outputs` capability. Its `analyze()`
 * writes the durable measurement; its outputs render that measurement as a file
 * — an HTML report and a class-cost list — and write nothing back. The split
 * matters: a measurement is expensive to earn and must not change under a
 * reader, while a file should be free to re-render and safe to delete.
 *
 * No LLM.
 */

import type {
	Analyzer,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalysisResult,
	AnalysisUnit,
} from "../../types.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { computeConfigHash } from "../../input-hash.js";
import { DEFAULT_TOKEN_UNITS_CONFIG, DEFAULT_WEIGHTS, type TokenUnitsConfig } from "./config.js";
import { foldSessionUnits, TokenUnitsProperties, type UsageRow } from "./fold.js";
import { classCostsOutput, reportOutput } from "./report.js";

export * from "./config.js";
export * from "./fold.js";
export * from "./leaves.js";

const SELECT_ROWS =
	"SELECT id, role, timestamp, usage, model, provider_message_id FROM messages WHERE session_id = ? ORDER BY rowid ASC";

export const tokenUnitsAnalyzer: Analyzer = {
	def: {
		id: "token-units",
		label: "Token Units (MITE, deterministic)",
		description:
			"Prices a session in MITE (Million Input-Token Equivalents): input x1, output x15, cache-read x0.1, cache-write x1.25. De-duplicates Claude Code's per-content-block rows by provider_message_id so one API call counts once, and attributes spend to request segments. Renders the daily report and the class-cost list. No LLM.",
		anchorSpan: "full_session",
		dependencies: [],
		outputSchema: TokenUnitsProperties,
	},
	version: {
		analyzerId: "token-units",
		major: 1,
		minor: 0,
		implementationKind: "deterministic",
		codeRef: "src/analyze/analyzers/token-units/index.ts",
	},
	prompts: {},
	defaultConfig: {
		id: "",
		analyzerId: "token-units",
		configHash: computeConfigHash(DEFAULT_TOKEN_UNITS_CONFIG as unknown as Record<string, unknown>),
		configJson: DEFAULT_TOKEN_UNITS_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	outputs: [reportOutput, classCostsOutput],

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		if (ctx.messages.length === 0) return [];

		const cfg = (ctx.config as unknown as TokenUnitsConfig) ?? DEFAULT_TOKEN_UNITS_CONFIG;
		const rows = (await ctx.db.prepare(SELECT_ROWS).all(ctx.sessionId)) as UsageRow[];
		const result = foldSessionUnits(ctx.sessionId, rows, cfg.weights ?? DEFAULT_WEIGHTS);

		// A session that grew since the last run is a NEW logical unit, not a stale
		// one: its message count is part of the unit's identity, so appending turns
		// produces a fresh node rather than leaving yesterday's total standing.
		// Readers take the newest node per source set, which is what the
		// corpus-wide latest-node read already does.
		const last = ctx.messages[ctx.messages.length - 1];
		return [
			{
				sources: [{ kind: "session", id: ctx.sessionId }],
				sourceSetHash: `token-units:${ctx.sessionId}:${ctx.messages.length}:${last?.id ?? ""}`,
				anchorKind: "session",
				anchorRef: ctx.sessionId,
				meta: { result: result as unknown as Record<string, unknown> },
			},
		];
	},

	analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): AnalysisResult {
		return {
			nodeKind: "metric",
			contentJson: unit.meta?.["result"] as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			edges: [{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 }],
		};
	},
};
