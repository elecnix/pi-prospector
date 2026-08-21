/**
 * piicatcher — the PIICatcher-method column-semantics PII detector analyzer.
 *
 * Licence note (issue #174): Tokern PIICatcher's LICENSE is **Apache-2.0**
 * (the referring issue said MIT; the upstream repository was checked).
 * Reference version studied: `tokern/piicatcher` v0.21.2 (latest release).
 * Only the *method* is implemented here — tabular fragment detection,
 * per-column value sampling, and statistical column classification. No
 * upstream code was vendored or ported.
 *
 * Sessions are not databases, but structured data flows through them: SQL
 * result sets in tool results, CSV blocks, JSON arrays of records. This
 * analyzer detects those **tabular fragments** (`fragments.ts`), segments
 * them into logical columns, and classifies each column by sampling its
 * values against the recognizer stack shared with the presidio analyzer
 * (`columns.ts` reuses the pure functions from `../presidio/recognizers.js`
 * — a code-organisation decision, not an analysis dependency: no presidio
 * node is consumed, so no dependency is declared). A column whose sampled
 * values match sensitive shapes at or above `sensitivityThreshold` is itself
 * the finding — frequency/shape analysis over a column, not repeated
 * single-value scanning.
 *
 * Scans the same four message fields as the other detectors (`content_text`,
 * `content_thinking`, `tool_calls`, `tool_results`) and emits one `metric`
 * node per session. No LLM; no subprocess; no model.
 *
 * Standalone like its sibling detectors: it declares no dependencies and
 * reads the session's raw messages directly. Its unit identity folds in every
 * message id in the session, so a session that grows new turns re-identifies
 * and is re-scanned on the next run.
 *
 * Redaction invariant: a finding carries `message_id`, the fragment kind, the
 * column name, sample size and match ratio, matched entity types, a redacted
 * preview, and a short SHA-256 fingerprint of the representative value —
 * derived identically to the secret detectors (`fingerprintOf`), so the
 * cross-detector `(credential fingerprint, message_id)` grouping of the
 * single-proposal-per-leak contract applies unchanged. The matched value
 * itself is never stored; fragments exist only in memory during the scan.
 * Per that contract this analyzer emits **metric nodes only**; grouping
 * findings into one proposal is the downstream synthesiser's job.
 *
 * The node anchors to the session, plus one `anchors` edge per message that
 * carried a finding, so `prospect show` can walk a finding back to the exact
 * turn.
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
import { DEFAULT_PIICATCHER_CONFIG, type PiicatcherConfig } from "./config.js";
import { detectTabularPii, type ColumnFinding, type PiicatcherScanResult } from "./detectors.js";

export const PIICATCHER_DEF: AnalyzerDef = {
	id: "piicatcher",
	label: "PII Detection (PIICatcher column semantics)",
	description:
		"Detects structured PII flowing through sessions with PIICatcher's column-semantics method: tabular fragments in tool results and message text (CSV blocks, JSON record arrays, SQL result tables) are segmented into columns, each column is judged by sampling its values against the shared recognizer stack, and columns whose values match sensitive shapes above the configured ratio are reported. Apache-2.0 method port (verified against upstream); no upstream code. Never stores the matched value.",
	anchorSpan: "full_session",
	dependencies: [],
};

export const PIICATCHER_VERSION: AnalyzerVersion = {
	analyzerId: PIICATCHER_DEF.id,
	// 1.0: initial version — three tabular formats (csv with delimiter sniffing
	// and header inference, json homogeneous record arrays, sql-table:
	// box-drawing / pipe / aligned columns), per-column value sampling with
	// statistical sensitivity classification over the shared recognizer stack,
	// fingerprint-based allow/deny lists, and per-field capping. Standalone,
	// deterministic, metric nodes only.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/piicatcher/index.ts",
};

export interface PiicatcherProperties {
	/** Session id this analysis covers. */
	session_id: string;
	/** Convenience boolean: were any column findings recorded? */
	has_findings: boolean;
	/** Total findings, after filtering and capping. */
	finding_count: number;
	/** The findings, capped at `maxMatchesPerField` per field. */
	findings: ColumnFinding[];
	/** Findings dropped for exceeding `maxMatchesPerField` in a field. */
	truncated_matches: number;
	/** Sampled values dropped by the allowlist (fingerprint or pattern). */
	allowlisted_values: number;
	/** Columns whose match ratio stayed below `sensitivityThreshold`. */
	below_threshold_columns: number;
	/** Tabular fragments detected across all scanned fields. */
	fragments_scanned: number;
	/** Columns examined across all fragments. */
	columns_classified: number;
	/** Fragments detected per format kind. */
	format_counts: Record<string, number>;
	/** Distinct message ids that carried at least one finding. */
	affected_message_ids: string[];
	/** Total messages scanned. */
	message_count: number;
}

// ──────────────────────────── analyzer ────────────────────────────

/**
 * Build the analyzer. The seam exists for symmetry with the other detectors;
 * detection is fully deterministic, so production and tests share behaviour.
 */
export function makePiicatcherAnalyzer(): Analyzer {
	return {
		def: PIICATCHER_DEF,
		version: PIICATCHER_VERSION,
		prompts: {} as Record<string, PromptVersion>,
		defaultConfig: {
			id: "",
			analyzerId: PIICATCHER_DEF.id,
			configHash: computeConfigHash(DEFAULT_PIICATCHER_CONFIG),
			configJson: DEFAULT_PIICATCHER_CONFIG as unknown as Record<string, unknown>,
			label: "default",
		},

		plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
			// No messages → nothing to scan. (An empty session still gets a summary
			// node from session-overview; this analyzer simply has nothing to report.)
			if (ctx.messages.length === 0) return [];

			// The source set is the full ordered message list, so a session that
			// grows new turns re-identifies (new message ids → new sourceSetHash →
			// `missing`) and is re-scanned on the next run.
			const sources: SourceRef[] = ctx.messages.map((m) => ({
				kind: "message" as const,
				id: m.id,
			}));
			return [
				{
					sources,
					sourceSetHash: computeSourceSetHash(sources),
					anchorKind: "session",
					anchorRef: ctx.sessionId,
				},
			];
		},

		async analyze(_unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
			const config =
				(ctx.config.configJson as unknown as PiicatcherConfig) ?? DEFAULT_PIICATCHER_CONFIG;
			// Re-read messages from the DB rather than the (possibly stale) plan-time
			// list, matching the other detectors' pattern.
			const messages = await ctx.getSessionMessages(ctx.sessionId);
			const scan: PiicatcherScanResult = detectTabularPii(messages, config);

			const properties: PiicatcherProperties = {
				session_id: ctx.sessionId,
				has_findings: scan.finding_count > 0,
				finding_count: scan.finding_count,
				findings: scan.findings,
				truncated_matches: scan.truncated_matches,
				allowlisted_values: scan.allowlisted_values,
				below_threshold_columns: scan.below_threshold_columns,
				fragments_scanned: scan.fragments_scanned,
				columns_classified: scan.columns_classified,
				format_counts: scan.format_counts,
				affected_message_ids: scan.affected_message_ids,
				message_count: messages.length,
			};

			// Anchor to the session (ordinal 0), then to each message that carried a
			// finding so it is traceable to the exact turn.
			const edges: AnalysisResult["edges"] = [
				{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
			];
			let ordinal = 1;
			for (const messageId of scan.affected_message_ids) {
				edges.push({
					toRefKind: REF_KINDS.MESSAGE,
					toRefId: messageId,
					edgeKind: EDGE_KINDS.ANCHORS,
					ordinal: ordinal++,
				});
			}

			return {
				nodeKind: "metric",
				contentJson: properties as unknown as Record<string, unknown>,
				anchorKind: "session",
				anchorRef: ctx.sessionId,
				edges,
			};
		},
	};
}

/** The production analyzer instance registered by default (enabled). */
export const piicatcherAnalyzer: Analyzer = makePiicatcherAnalyzer();
export { detectTabularPii, type PiicatcherScanResult } from "./detectors.js";
export { DEFAULT_PIICATCHER_CONFIG, PiicatcherConfigSchema, type PiicatcherConfig } from "./config.js";
export { classifyFragment, classifyValue, type ColumnFinding } from "./columns.js";
export { detectFragments, FRAGMENT_KINDS, type FragmentKind, type TabularFragment } from "./fragments.js";
