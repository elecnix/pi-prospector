/**
 * dataprofiler — the Capital One DataProfiler-method tabular file PII detector
 * analyzer.
 *
 * Licence note (issue #175): Capital One DataProfiler's LICENSE is
 * **Apache-2.0** (verified against the upstream repository). Reference
 * version studied: `capitalone/DataProfiler` v0.13.4 (latest release at time
 * of writing). Only the *method* is implemented here — schema/statistics/
 * entity profiling of tabular files, labelling which columns carry sensitive
 * entities from header labels validated by value-distribution analysis. No
 * upstream code was vendored or ported (the original is Python).
 *
 * **The file-profiling path.** The immediately-upstream piicatcher analyzer
 * covers structured fragments *inline* in tool results; this analyzer covers
 * files a session READ or WROTE: a tool call's normalized arguments name a
 * tabular path (`.csv`, `.tsv`/`.tab`, `.json`/`.jsonl`; binary tabular
 * formats are skipped — their bytes do not survive a text transcript), the
 * paired tool result captured the content (paired by tool-call id through the
 * shared action stream), and the captured content is profiled: header-label
 * inference flags columns whose *label* indicates sensitivity, independent of
 * values; value-distribution validation checks each label against the shapes
 * its implied entity types would produce. Label + distribution combine into a
 * per-column verdict (`confirmed` / `label-only` / `values-only`), and the
 * finding is about the FILE — anchored to the message whose tool call touched
 * it, path in the finding metadata so a reviewer can act on the actual file.
 *
 * Scans the session's tool-call stream rather than the four prose fields; the
 * content it reads is the same evidence the other detectors see (tool calls
 * and tool results), organised by file. One `metric` node per session. No
 * LLM; no subprocess; no model.
 *
 * Standalone like its sibling detectors: it declares no dependencies and
 * works from the session's raw messages (it consumes none of piicatcher's or
 * presidio's nodes — the recognizers it reuses are pure functions from
 * `../piicatcher/columns.js`, a code-organisation decision, not an analysis
 * dependency). Its unit identity folds in every message id in the session, so
 * a session that grows new turns re-identifies and is re-scanned on the next
 * run.
 *
 * Redaction invariant: findings carry the file path, column names, verdicts,
 * ratios, a redacted preview, and a short SHA-256 fingerprint of a
 * representative value — derived identically to the secret detectors
 * (`fingerprintOf`), so the cross-detector `(credential fingerprint,
 * message_id)` grouping of the single-proposal-per-leak contract applies
 * unchanged. The matched value itself and the file content are never stored.
 * Per that contract this analyzer emits **metric nodes only**; grouping
 * findings into one proposal is the downstream synthesiser's job.
 *
 * The node anchors to the session, plus one `anchors` edge per message whose
 * tool call produced a finding, so `prospect show` can walk a finding back to
 * the exact turn.
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
import {
	DEFAULT_DATAPROFILER_CONFIG,
	type DataprofilerConfig,
} from "./config.js";
import {
	profileSessionFiles,
	DataprofilerScanResult,
} from "./detectors.js";
import { Type, type Static } from "typebox";

/** The node content: the dataprofiler scan result plus the session-level envelope fields. */
export const DataprofilerProperties = Type.Object({
	...DataprofilerScanResult.properties,
	/** Session id this analysis covers. */
	session_id: Type.String(),
	/** Convenience boolean: were any file findings recorded? */
	has_findings: Type.Boolean(),
	/** Total messages scanned. */
	message_count: Type.Number(),
});
export type DataprofilerProperties = Static<typeof DataprofilerProperties>;

export const DATAPROFILER_DEF: AnalyzerDef = {
	id: "dataprofiler",
	label: "PII Detection (DataProfiler tabular file profiling)",
	description:
		"Detects PII in the tabular FILES a session read or wrote, with Capital One DataProfiler's method: a tool call's normalized arguments name a tabular path, the paired tool result captured its content, and the content is profiled — header labels flag sensitive columns independent of values, value-distribution validation confirms or downgrades each label, and the finding is about the file (path in metadata, anchored to the touching message). Apache-2.0 method port (verified against upstream); no upstream code. Never stores the file content or a matched value.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: DataprofilerProperties,
};

export const DATAPROFILER_VERSION: AnalyzerVersion = {
	analyzerId: DATAPROFILER_DEF.id,
	// 1.0: initial version — file-touch detection from normalized tool-call
	// arguments (structured read/write tools and bash paths/redirects), content
	// capture via tool-call-id pairing, CSV/TSV/JSON(+NDJSON) table parsing,
	// header-label inference over eight groups, value-distribution validation
	// over the shared recognizer stack, combined per-column verdicts, file-level
	// findings, fingerprint-based allow/deny lists, and per-message capping.
	// Standalone, deterministic, metric nodes only.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/dataprofiler/index.ts",
};


// ──────────────────────────── analyzer ────────────────────────────

/**
 * Build the analyzer. The seam exists for symmetry with the other detectors;
 * detection is fully deterministic, so production and tests share behaviour.
 */
export function makeDataprofilerAnalyzer(): Analyzer {
	return {
		def: DATAPROFILER_DEF,
		version: DATAPROFILER_VERSION,
		prompts: {} as Record<string, PromptVersion>,
		defaultConfig: {
			id: "",
			analyzerId: DATAPROFILER_DEF.id,
			configHash: computeConfigHash(DEFAULT_DATAPROFILER_CONFIG),
			configJson: DEFAULT_DATAPROFILER_CONFIG as unknown as Record<string, unknown>,
			label: "default",
		},

		plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
			// No messages → no tool stream → nothing to profile. (An empty session
			// still gets a summary node from session-overview; this analyzer simply
			// has nothing to report.)
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
				(ctx.config.configJson as unknown as DataprofilerConfig) ?? DEFAULT_DATAPROFILER_CONFIG;
			// Re-read messages from the DB rather than the (possibly stale) plan-time
			// list, matching the other detectors' pattern.
			const messages = await ctx.getSessionMessages(ctx.sessionId);
			const scan: DataprofilerScanResult = profileSessionFiles(messages, config);

			const properties: DataprofilerProperties = {
				session_id: ctx.sessionId,
				has_findings: scan.finding_count > 0,
				finding_count: scan.finding_count,
				findings: scan.findings,
				truncated_matches: scan.truncated_matches,
				files_touched: scan.files_touched,
				files_profiled: scan.files_profiled,
				files_skipped_binary: scan.files_skipped_binary,
				touches_without_content: scan.touches_without_content,
				columns_classified: scan.columns_classified,
				sensitive_columns: scan.sensitive_columns,
				label_only_columns: scan.label_only_columns,
				below_threshold_columns: scan.below_threshold_columns,
				allowlisted_values: scan.allowlisted_values,
				format_counts: scan.format_counts,
				affected_message_ids: scan.affected_message_ids,
				message_count: messages.length,
			};

			// Anchor to the session (ordinal 0), then to each message whose tool
			// call produced a finding so it is traceable to the exact turn.
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
export const dataprofilerAnalyzer: Analyzer = makeDataprofilerAnalyzer();
export { profileSessionFiles, type DataprofilerScanResult, type FileProfileFinding } from "./detectors.js";
export { DEFAULT_DATAPROFILER_CONFIG, DataprofilerConfigSchema, type DataprofilerConfig } from "./config.js";
export { profileTable, parseTable, type SensitiveColumn, type ColumnVerdict } from "./profile.js";
export { detectFileTouches, type FileTouch } from "./file-touches.js";
export { inferHeaderLabels, HEADER_LABEL_RULES } from "./headers.js";
