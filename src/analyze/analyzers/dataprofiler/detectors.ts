/**
 * DataProfiler-method detection over a session's message stream: file-touch
 * pairing, table parsing, per-column label + distribution profiling,
 * aggregated into **file-level** findings.
 *
 * The finding is about the FILE — "customers.csv: columns 2,5 carry PII
 * (email, phone)" — anchored to the assistant message whose tool call read or
 * wrote it, with the path carried in the finding so a reviewer can act on the
 * actual file. Per-column entries carry a redacted preview and a short
 * SHA-256 fingerprint of a representative value, derived identically to every
 * other detector (`fingerprintOf`), so the cross-detector
 * `(credential fingerprint, message_id)` grouping of the
 * single-proposal-per-leak contract applies unchanged. File content exists
 * only in memory during the scan; the matched values themselves are never
 * stored.
 *
 * Pure and deterministic. Per that contract this analyzer emits **metric
 * nodes only**; grouping findings into one proposal is the downstream
 * synthesiser's job.
 */

import type { MessageRow } from "../../types.js";
import {
	DEFAULT_DATAPROFILER_CONFIG,
	type DataprofilerConfig,
} from "./config.js";
import { detectFileTouches, FileFormatSchema, type FileFormat } from "./file-touches.js";
import { parseTable, profileTable, VERDICT_SEVERITY, SensitiveColumn, type SensitiveColumn as TSensitiveColumn } from "./profile.js";
import { Type, type Static } from "typebox";

export { DEFAULT_DATAPROFILER_CONFIG, DataprofilerConfigSchema, type DataprofilerConfig } from "./config.js";
export { detectFileTouches, FILE_FORMATS, FileFormatSchema, type FileFormat, type FileTouch } from "./file-touches.js";
export {
	parseTable,
	profileTable,
	COLUMN_VERDICTS,
	VERDICT_SEVERITY,
	type ColumnVerdict,
	type ProfiledTable,
	SensitiveColumn,
} from "./profile.js";
export { HEADER_LABEL_RULES, inferHeaderLabels } from "./headers.js";

/** One file-level finding: which file, how touched, which columns carry PII. */
export const FileProfileFinding = Type.Object({
	/** The file path, verbatim from the tool-call arguments. */
	path: Type.String(),
	/** Read or write. */
	direction: Type.Union([Type.Literal("read"), Type.Literal("write")]),
	/** The tabular format implied by the extension. */
	format: FileFormatSchema,
	/** Tool that performed the touch. */
	tool: Type.String(),
	/** Assistant message whose tool call read/wrote the file — the anchor. */
	message_id: Type.String(),
	/** Message carrying the paired result, when one arrived. */
	result_message_id: Type.Union([Type.String(), Type.Null()]),
	/** Data rows in the parsed table. */
	row_count: Type.Number(),
	/** Columns in the parsed table. */
	column_count: Type.Number(),
	/** The sensitive columns, in column order. */
	sensitive_columns: Type.Array(SensitiveColumn),
	/** Highest severity across the columns' verdicts. */
	severity: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
});
export type FileProfileFinding = Static<typeof FileProfileFinding>;

export const DataprofilerScanResult = Type.Object({
	/** Total file findings, after per-message capping. */
	finding_count: Type.Number(),
	/** The findings, capped at `maxMatchesPerField` per message. */
	findings: Type.Array(FileProfileFinding),
	/** Distinct tabular files touched (any format, before profiling). */
	files_touched: Type.Number(),
	/** Touches whose content parsed into a profiled table. */
	files_profiled: Type.Number(),
	/** Tabular-binary paths seen and deliberately not extracted. */
	files_skipped_binary: Type.Number(),
	/** Touches with no unambiguously captured content. */
	touches_without_content: Type.Number(),
	/** Columns examined across all profiled tables. */
	columns_classified: Type.Number(),
	/** Columns flagged sensitive. */
	sensitive_columns: Type.Number(),
	/** Columns downgraded to `label-only`. */
	label_only_columns: Type.Number(),
	/** Columns below every flagging rule. */
	below_threshold_columns: Type.Number(),
	/** Values dropped by the allowlist (fingerprint or pattern). */
	allowlisted_values: Type.Number(),
	/** Findings dropped for exceeding `maxMatchesPerField` on a message. */
	truncated_matches: Type.Number(),
	/** Profiled tables per format kind. */
	format_counts: Type.Record(Type.String(), Type.Number()),
	/** Distinct messages whose tool calls produced at least one finding. */
	affected_message_ids: Type.Array(Type.String()),
});
export type DataprofilerScanResult = Static<typeof DataprofilerScanResult>;

function emptyFormatCounts(): Record<FileFormat, number> {
	return { csv: 0, tsv: 0, json: 0 };
}

const SEVERITY_RANK = { low: 1, medium: 2, high: 3 } as const;

/**
 * Detect tabular-file PII across a session's messages. Pure and deterministic.
 *
 * @param messages the session's message rows, in order
 * @param config the resolved analyzer config (defaults applied when omitted)
 */
export function profileSessionFiles(
	messages: readonly MessageRow[],
	config: DataprofilerConfig = DEFAULT_DATAPROFILER_CONFIG,
): DataprofilerScanResult {
	const touchScan = detectFileTouches(messages, config);
	const findings: FileProfileFinding[] = [];
	let filesProfiled = 0;
	let touchesWithoutContent = 0;
	let columnsClassified = 0;
	let sensitiveColumns = 0;
	let labelOnlyColumns = 0;
	let belowThreshold = 0;
	let allowlistedValues = 0;
	let truncated = 0;
	const formatCounts = emptyFormatCounts();
	const distinctPaths = new Set<string>();
	const perMessage = new Map<string, FileProfileFinding[]>();

	for (const touch of touchScan.touches) {
		distinctPaths.add(touch.path);
		if (touch.content === null) {
			touchesWithoutContent++;
			continue;
		}
		const table = parseTable(touch.content, touch.format);
		if (table === null) continue; // capture truncated/decorated: no honest profile
		filesProfiled++;
		formatCounts[touch.format] += 1;

		const profile = profileTable(table, config);
		columnsClassified += profile.columns_classified;
		belowThreshold += profile.below_threshold_columns;
		labelOnlyColumns += profile.label_only_columns;
		allowlistedValues += profile.allowlisted_values;
		if (profile.sensitive.length === 0) continue;
		sensitiveColumns += profile.sensitive.length;

		const severity = profile.sensitive.reduce<"low" | "medium" | "high">(
			(acc, c) => (SEVERITY_RANK[VERDICT_SEVERITY[c.verdict]] > SEVERITY_RANK[acc] ? VERDICT_SEVERITY[c.verdict] : acc),
			"low",
		);
		const finding: FileProfileFinding = {
			path: touch.path,
			direction: touch.direction,
			format: touch.format,
			tool: touch.tool,
			message_id: touch.callMessageId,
			result_message_id: touch.resultMessageId,
			row_count: table.rows.length,
			column_count: table.header.length,
			sensitive_columns: profile.sensitive,
			severity,
		};
		const bucket = perMessage.get(touch.callMessageId) ?? [];
		bucket.push(finding);
		perMessage.set(touch.callMessageId, bucket);
	}

	// Cap per message; survivors beyond the cap are counted, not listed.
	const affected = new Set<string>();
	for (const [messageId, bucket] of [...perMessage.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		if (bucket.length > config.maxMatchesPerField) {
			truncated += bucket.length - config.maxMatchesPerField;
		}
		const kept = bucket.slice(0, config.maxMatchesPerField);
		if (kept.length > 0) affected.add(messageId);
		findings.push(...kept);
	}

	return {
		finding_count: findings.length,
		findings,
		files_touched: distinctPaths.size,
		files_profiled: filesProfiled,
		files_skipped_binary: touchScan.skippedBinary,
		touches_without_content: touchesWithoutContent,
		columns_classified: columnsClassified,
		sensitive_columns: sensitiveColumns,
		label_only_columns: labelOnlyColumns,
		below_threshold_columns: belowThreshold,
		allowlisted_values: allowlistedValues,
		truncated_matches: truncated,
		format_counts: formatCounts,
		affected_message_ids: [...affected].sort(),
	};
}
