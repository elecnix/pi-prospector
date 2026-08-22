/**
 * PIICatcher-method detection over a session's message stream: tabular
 * fragment detection plus per-column value sampling, aggregated into
 * column-sensitivity findings.
 *
 * Pure and deterministic. Findings carry the fragment kind, the column name,
 * the sample size and match ratio, the matched entity types, and — per the
 * redaction invariant shared with every detector — a redacted preview and a
 * short SHA-256 fingerprint (`fingerprintOf`, derived identically to the
 * secret detectors) of the column's representative value. The matched value
 * itself is never stored; fragments live only in memory during the scan.
 */

import type { MessageRow } from "../../types.js";
import { fingerprintOf, redact, type LeakField } from "../secret-scanner.js";
import {
	DEFAULT_PIICATCHER_CONFIG,
	type PiicatcherConfig,
} from "./config.js";
import { detectFragments, type FragmentKind, FRAGMENT_KINDS } from "./fragments.js";
import { Type, type Static } from "typebox";
import { classifyFragment, ColumnFinding } from "./columns.js";

export { fingerprintOf, redact } from "../secret-scanner.js";
export { DEFAULT_PIICATCHER_CONFIG, PiicatcherConfigSchema, type PiicatcherConfig } from "./config.js";
export { detectFragments, FRAGMENT_KINDS, type FragmentKind, type TabularFragment } from "./fragments.js";
export { classifyFragment, classifyValue, type ColumnFinding } from "./columns.js";

export const PiicatcherScanResult = Type.Object({
	/** Total column findings, after filtering and per-field capping. */
	finding_count: Type.Number(),
	/** The findings, capped at `maxMatchesPerField` per message field. */
	findings: Type.Array(ColumnFinding),
	/** Findings dropped for exceeding `maxMatchesPerField` in a field. */
	truncated_matches: Type.Number(),
	/** Sampled values dropped by the allowlist (fingerprint or pattern). */
	allowlisted_values: Type.Number(),
	/** Columns whose match ratio stayed below `sensitivityThreshold`. */
	below_threshold_columns: Type.Number(),
	/** Tabular fragments detected across all scanned fields. */
	fragments_scanned: Type.Number(),
	/** Columns examined across all fragments. */
	columns_classified: Type.Number(),
	/** Findings per fragment kind. */
	format_counts: Type.Record(Type.String(), Type.Number()),
	/** Distinct message ids that carried at least one finding. */
	affected_message_ids: Type.Array(Type.String()),
});
export type PiicatcherScanResult = Static<typeof PiicatcherScanResult>;

/** Fields of a MessageRow to scan, mirroring the shared engine's field set. */
const SCAN_FIELDS: ReadonlyArray<{ row: keyof MessageRow; label: LeakField }> = [
	{ row: "content_text", label: "content_text" },
	{ row: "content_thinking", label: "content_thinking" },
	{ row: "tool_calls", label: "tool_calls" },
	{ row: "tool_results", label: "tool_results" },
];

function emptyFormatCounts(): Record<FragmentKind, number> {
	return { csv: 0, json: 0, "sql-table": 0 };
}

/**
 * Detect column-level PII across a session's messages. Pure and
 * deterministic.
 *
 * @param messages the session's message rows, in order
 * @param config the resolved analyzer config (defaults applied when omitted)
 */
export function detectTabularPii(
	messages: readonly MessageRow[],
	config: PiicatcherConfig = DEFAULT_PIICATCHER_CONFIG,
): PiicatcherScanResult {
	const findings: ColumnFinding[] = [];
	let truncated = 0;
	let allowlisted = 0;
	let belowThreshold = 0;
	let fragmentsScanned = 0;
	let columnsClassified = 0;
	const formatCounts = emptyFormatCounts();
	const affected = new Set<string>();

	for (const m of messages) {
		for (const { row, label } of SCAN_FIELDS) {
			const raw = m[row];
			if (typeof raw !== "string" || raw.length === 0) continue;

			const fragments = detectFragments(raw, m.id, label, config);
			fragmentsScanned += fragments.length;
			for (const f of fragments) formatCounts[f.kind] += 1;

			const fieldFindings: ColumnFinding[] = [];
			for (let fi = 0; fi < fragments.length; fi++) {
				const fragment = fragments[fi]!;
				const result = classifyFragment(fragment, config);
				columnsClassified += result.columns_classified;
				belowThreshold += result.columns_below_threshold;
				allowlisted += result.allowlisted_values;
				for (const finding of result.findings) {
					finding.fragment_index = fi;
					fieldFindings.push(finding);
				}
			}

			// Cap per message field; survivors beyond the cap are counted, not listed.
			let kept: ColumnFinding[];
			if (fieldFindings.length > config.maxMatchesPerField) {
				truncated += fieldFindings.length - config.maxMatchesPerField;
				kept = fieldFindings.slice(0, config.maxMatchesPerField);
			} else {
				kept = fieldFindings;
			}
			if (kept.length > 0) affected.add(m.id);
			findings.push(...kept);
		}
	}

	return {
		finding_count: findings.length,
		findings,
		truncated_matches: truncated,
		allowlisted_values: allowlisted,
		below_threshold_columns: belowThreshold,
		fragments_scanned: fragmentsScanned,
		columns_classified: columnsClassified,
		format_counts: formatCounts,
		affected_message_ids: [...affected].sort(),
	};
}
