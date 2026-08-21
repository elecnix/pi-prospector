/**
 * File profiling: parse a captured file's content into a table, then judge
 * each column by combining header-label inference with value-distribution
 * validation — DataProfiler's method (issue #175).
 *
 * Two independent evidence channels per column:
 *
 * - **Label score** — does the header cell text indicate sensitivity?
 *   (`headers.ts`.) Fires independently of any value.
 * - **Value score** — what fraction of the sampled values match the sensitive
 *   shapes the label implies (or, for an unlabelled column, *any* sensitive
 *   shape)? Sampling is top-down through data rows; empty cells count in the
 *   denominator, exactly as in the piicatcher analyzer: a sparse column with
 *   one email among blanks is not "an email column".
 *
 * Per-value classification **reuses the shared recognizer stack** via
 * `classifyValue` from `../piicatcher/columns.js` — a code-organisation
 * decision, not an analysis dependency: pure functions with no node output,
 * so dependency-scoped visibility does not apply and no dependency is
 * declared. Sharing them keeps every detector agreeing about what an email or
 * a card number is.
 *
 * The combined verdict:
 *
 * - **confirmed** — a label fired AND the value distribution supports it
 *   (`valueScore ≥ valueThreshold`): "column labelled email that is 90%
 *   email-shaped".
 * - **label-only** — a label fired but the distribution does not support it:
 *   downgraded. Still reported (the header alone is evidence a reviewer must
 *   see), at low severity, with the measured ratio carried alongside.
 * - **values-only** — no label, but the distribution crosses the threshold on
 *   its own.
 *
 * Determinism: fixed sampling order, fixed recognizer order, fixed
 * tie-breaking (highest score, then registry order). Same input ⇒ same
 * findings.
 */

import { classifyValue } from "../piicatcher/columns.js";
import { fingerprintOf, redact } from "../secret-scanner.js";
import type { PiiEntityType } from "../presidio/recognizers.js";
import type { DataprofilerConfig } from "./config.js";
import { inferHeaderLabels, type HeaderLabelRule } from "./headers.js";
import type { FileFormat } from "./file-touches.js";

export { fingerprintOf, redact } from "../secret-scanner.js";

/** A parsed table: header names plus stringified data rows. */
export interface ProfiledTable {
	header: string[];
	rows: string[][];
}

/** The per-column sensitivity verdict. */
export const COLUMN_VERDICTS = ["confirmed", "label-only", "values-only"] as const;
export type ColumnVerdict = (typeof COLUMN_VERDICTS)[number];

/** Severity per verdict, ordered as the presidio scale. */
export const VERDICT_SEVERITY: Record<ColumnVerdict, "low" | "medium" | "high"> = {
	confirmed: "high",
	"label-only": "low",
	"values-only": "medium",
};

/** One sensitive-column verdict inside a file finding. Never carries raw values. */
export interface SensitiveColumn {
	/** 0-based column position. */
	column_index: number;
	/** Header cell text, or `column_N` when the file had no usable header. */
	column_name: string;
	/** Label groups that fired on the header (catalogue order). */
	labels: string[];
	/** Sampled values, including empty cells (the denominator). */
	sample_size: number;
	/** Sampled values matching an implied (or any) sensitive shape. */
	match_count: number;
	/** `match_count / sample_size`. */
	value_ratio: number;
	/** Combined score: `weight·value_ratio + (1−weight)·labelScore`. */
	score: number;
	verdict: ColumnVerdict;
	/** Entity types matched over the sample, with per-type counts. */
	entity_types: Record<string, number>;
	/** Redacted preview of the first matching value (sample order). */
	redacted_preview: string;
	/** Short SHA-256 fingerprint of that value — dedup/allow/deny key. */
	fingerprint: string;
}

export interface ColumnProfileResult {
	/** Columns whose verdict flagged them sensitive. */
	sensitive: SensitiveColumn[];
	/** Columns examined. */
	columns_classified: number;
	/** Columns that stayed below every flagging rule. */
	below_threshold_columns: number;
	/** Columns whose verdict was downgraded to `label-only`. */
	label_only_columns: number;
	/** Values skipped by the allowlist (fingerprint or pattern). */
	allowlisted_values: number;
}

// ──────────────────────────── table parsing ────────────────────────────

const NUMERIC_CELL = /^-?\d+(?:\.\d+)?$/;

/** Split one CSV line on `delim`, honouring double-quoted cells (no embedded newlines). */
function splitCsvLine(line: string, delim: string): string[] {
	const cells: string[] = [];
	let cur = "";
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]!;
		if (inQuotes) {
			if (ch === '"') {
				if (line[i + 1] === '"') {
					cur += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				cur += ch;
			}
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === delim) {
			cells.push(cur);
			cur = "";
		} else {
			cur += ch;
		}
	}
	cells.push(cur);
	return cells.map((c) => c.trim());
}

function stringifyCell(v: unknown): string {
	if (v === null || v === undefined) return "";
	if (typeof v === "string") return v.trim();
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	return JSON.stringify(v);
}

interface HomogeneityCheck {
	ok: boolean;
	keys: string[];
	rows: string[][];
}

/** Check a parsed array is a homogeneous list of object records; flatten to rows. */
function homogeneousRecords(parsed: unknown): HomogeneityCheck {
	if (!Array.isArray(parsed) || parsed.length < 1) return { ok: false, keys: [], rows: [] };
	let keys: string[] | null = null;
	const rows: string[][] = [];
	for (const rec of parsed) {
		if (typeof rec !== "object" || rec === null || Array.isArray(rec)) {
			return { ok: false, keys: [], rows: [] };
		}
		const obj = rec as Record<string, unknown>;
		const ks = Object.keys(obj);
		if (ks.length < 1) return { ok: false, keys: [], rows: [] };
		if (keys === null) {
			keys = ks;
		} else {
			const a = [...keys].sort().join("\u0000");
			const b = [...ks].sort().join("\u0000");
			if (a !== b) return { ok: false, keys: [], rows: [] };
		}
		rows.push(keys.map((k) => stringifyCell(obj[k])));
	}
	return { ok: true, keys: keys ?? [], rows };
}

/** Parse NDJSON (one JSON object per line); tolerant of blank lines. */
function ndjsonRecords(content: string): HomogeneityCheck {
	const records: unknown[] = [];
	for (const line of content.split("\n")) {
		const t = line.trim();
		if (t.length === 0) continue;
		try {
			records.push(JSON.parse(t));
		} catch {
			return { ok: false, keys: [], rows: [] };
		}
	}
	return homogeneousRecords(records);
}

/**
 * Parse captured file content into a table for profiling.
 *
 * - **json** — whole-content array of homogeneous object records, or NDJSON
 *   objects line-by-line.
 * - **csv** — delimiter sniffed in fixed order (`,` `;`) with quoted-cell
 *   support; **tsv** — plain tab split. The first row is the header when it
 *   has content and no numeric-shaped cell; otherwise columns are named
 *   `column_N` and the first row counts as data.
 *
 * Returns null when the content does not parse as the claimed format — a
 * transcript's capture may be truncated or decorated, and profiling a
 * mis-parsed blob would manufacture findings.
 */
export function parseTable(content: string, format: FileFormat): ProfiledTable | null {
	if (format === "json") {
		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch {
			// Not whole-file JSON: try NDJSON (one object per line).
			const ndjson = ndjsonRecords(content);
			return ndjson.ok ? { header: ndjson.keys, rows: ndjson.rows } : null;
		}
		const check = homogeneousRecords(parsed);
		if (check.ok) return { header: check.keys, rows: check.rows };
		// An NDJSON file whose first line parses but whole-content parse failed is
		// already covered above; a whole-content non-array is not a record table.
		return null;
	}

	const lines = content.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length < 2) return null; // a header row alone profiles nothing

	const delim = format === "tsv" ? "\t" : null;
	let parsedRows: string[][] | null = null;

	if (delim !== null) {
		parsedRows = lines.map((l) => l.split(delim).map((c) => c.trim()));
	} else {
		for (const candidate of [",", ";"]) {
			const attempt = lines.map((l) => splitCsvLine(l, candidate));
			const widths = new Set(attempt.map((r) => r.length));
			if (widths.size === 1 && attempt[0]!.length >= 1) {
				parsedRows = attempt;
				break;
			}
		}
	}
	if (parsedRows === null) return null;

	const width = parsedRows[0]!.length;
	if (width < 1) return null;
	// Pad ragged rows so indexing never lies; extra cells are dropped.
	const normalised = parsedRows.map((r) =>
		Array.from({ length: width }, (_, i) => r[i]?.trim() ?? ""),
	);

	const first = normalised[0]!;
	const hasHeader = first.some((c) => c.length > 0) && first.every((c) => !NUMERIC_CELL.test(c));
	const header = hasHeader
		? first
		: Array.from({ length: width }, (_, i) => `column_${i + 1}`);
	const rows = hasHeader ? normalised.slice(1) : normalised;
	if (rows.length < 1) return null;
	return { header, rows };
}

// ──────────────────────────── column classification ────────────────────────────

/**
 * Profile every column of one parsed table. Pure and deterministic.
 *
 * A column is flagged when its header carries a sensitive label (independent
 * of values — the finding then says how much value support exists) or when its
 * unlabelled value distribution reaches `valueThreshold`.
 */
export function profileTable(
	table: ProfiledTable,
	config: DataprofilerConfig,
): ColumnProfileResult {
	const allowFp = new Set(config.allowFingerprints);
	const denyFp = new Set(config.denyFingerprints);
	const allowPatterns = config.allowPatterns.map((src) => new RegExp(src, "u"));

	const width = table.header.length;
	const sensitive: SensitiveColumn[] = [];
	let allowlistedValues = 0;
	let belowThreshold = 0;
	let labelOnly = 0;

	for (let col = 0; col < width; col++) {
		const labels: HeaderLabelRule[] = config.headerLabels.enabled
			? inferHeaderLabels(table.header[col] ?? "", config.headerLabels.groups)
			: [];
		const implied: ReadonlySet<PiiEntityType> = new Set(labels.flatMap((r) => r.impliedEntities));

		// Fixed sampling order: top-down through data rows. Empty cells count in
		// the denominator — sparsity weakens the value evidence honestly.
		const sample: string[] = [];
		for (const row of table.rows) {
			if (sample.length >= config.sampleSize) break;
			sample.push(row[col]?.trim() ?? "");
		}
		if (sample.length === 0) continue;

		let matchCount = 0;
		const entityTypes: Record<string, number> = {};
		let representative: { preview: string; fingerprint: string } | null = null;

		for (const value of sample) {
			if (value.length === 0) continue; // denominator only
			// No floor here: a deny-listed value must surface even below it.
			const judged = classifyValue(value);
			if (!judged) continue;
			// Shape validation against the label's implied types: a labelled column
			// only accepts its own implied shapes (a label with no deterministic
			// recognizer — name, dob, salary — accepts none, so it can only ever be
			// label-only); an unlabelled column accepts any sensitive shape.
			if (labels.length > 0 && !implied.has(judged.entity_type as PiiEntityType)) continue;
			const fp = fingerprintOf(judged.matched_text);
			const denied = denyFp.has(fp);
			if (!denied) {
				if (allowFp.has(fp) || allowPatterns.some((re) => re.test(judged.matched_text))) {
					allowlistedValues++;
					continue;
				}
				if (judged.score < config.minScore) continue;
			}
			matchCount++;
			entityTypes[judged.entity_type] = (entityTypes[judged.entity_type] ?? 0) + 1;
			if (representative === null) {
				representative = { preview: redact(judged.matched_text), fingerprint: fp };
			}
		}

		const valueRatio = matchCount / sample.length;
		const labelScore = labels.length > 0 ? 1 : 0;
		const score =
			config.valueScoreWeight * valueRatio + (1 - config.valueScoreWeight) * labelScore;

		let verdict: ColumnVerdict;
		if (labels.length > 0 && valueRatio >= config.valueThreshold) {
			verdict = "confirmed";
		} else if (labels.length > 0) {
			verdict = "label-only";
		} else if (valueRatio >= config.valueThreshold) {
			verdict = "values-only";
		} else {
			belowThreshold++;
			continue;
		}
		if (verdict === "label-only") labelOnly++;

		sensitive.push({
			column_index: col,
			column_name: table.header[col] ?? `column_${col + 1}`,
			labels: labels.map((r) => r.group),
			sample_size: sample.length,
			match_count: matchCount,
			value_ratio: valueRatio,
			score,
			verdict,
			entity_types: entityTypes,
			// A confirmed/values-only column always has a representative (a match
			// exists by definition). A label-only column with no shape evidence has
			// none: its fingerprint key is derived from the header text, never from
			// a value, and the preview says so plainly.
			redacted_preview: representative?.preview ?? "(no shape evidence)",
			fingerprint: representative?.fingerprint ?? fingerprintOf(`column:${table.header[col] ?? col}`),
		});
	}

	return {
		sensitive,
		columns_classified: width,
		below_threshold_columns: belowThreshold,
		label_only_columns: labelOnly,
		allowlisted_values: allowlistedValues,
	};
}
