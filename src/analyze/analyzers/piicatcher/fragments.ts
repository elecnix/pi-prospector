/**
 * Tabular fragment detection: finding structured data blocks inside a
 * message's text fields.
 *
 * PIICatcher-method segmentation applied to session content (issue #174).
 * Three fragment kinds, each detected deterministically with fixed thresholds:
 *
 * - **csv** — runs of lines that split consistently under one sniffed
 *   delimiter (candidates tried in fixed order: `,`, `;`, tab). Header
 *   inference: the first row is the header when no cell is numeric-shaped.
 * - **json** — balanced-bracket `[ { … }, … ]` spans that parse to an array
 *   of homogeneous object records (identical key sets, ≥ 2 keys).
 * - **sql-table** — SQL result tables in three renderings: box-drawing
 *   (`│ … │` with `──┼──` rules), ASCII pipe tables (`| … |` with `+---+`
 *   borders, i.e. `mysql -t` / markdown), and aligned plain-text columns
 *   (runs of lines splitting identically on 2+ spaces).
 *
 * Everything here is pure and deterministic: fixed candidate order, fixed
 * minimum sizes, no locale- or environment-dependent behaviour. Detection
 * order is stable and load-bearing for line consumption: JSON spans claim
 * their lines first, then ruled tables, then CSV, then aligned columns — so
 * a pipe table is never re-reported as a `|`-delimited CSV block.
 */

import { Type } from "typebox";

import type { LeakField } from "../secret-scanner.js";
import type { PiicatcherConfig } from "./config.js";

/** The tabular fragment kinds a finding can name. */
export const FRAGMENT_KINDS = ["csv", "json", "sql-table"] as const;
export type FragmentKind = (typeof FRAGMENT_KINDS)[number];

export const FragmentKindSchema = Type.Union([
	Type.Literal("csv"),
	Type.Literal("json"),
	Type.Literal("sql-table"),
]);

/** One detected structured-data block. Carries positions, never raw PII onward — rows hold field text by design of the caller (in-memory only). */
export interface TabularFragment {
	kind: FragmentKind;
	/** Message the fragment was found in. */
	message_id: string;
	/** Which message field contained it. */
	field: LeakField;
	/** 1-based line number of the fragment's first line within the field text. */
	start_line: number;
	/** Column names: inferred header cells or `column_N`. */
	header: string[];
	/** Data rows (header excluded), cells trimmed. */
	rows: string[][];
}

/** Minimum lines in a line-based run (header + at least two data rows). */
const MIN_RUN_LINES = 3;
/** Minimum records in a JSON array fragment. */
const MIN_JSON_RECORDS = 2;
/** Minimum columns in any fragment. */
const MIN_COLUMNS = 2;
/** CSV delimiter candidates, in sniffing order. Pipe is deliberately absent: ruled tables claim it first. */
const CSV_DELIMITERS = [",", ";", "\t"] as const;

const NUMERIC_CELL = /^-?\d+(?:\.\d+)?$/;

// ──────────────────────────── cell splitting ────────────────────────────

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

/**
 * Header inference: the first row is a header when it has content and no
 * cell is numeric-shaped. Deterministic; data-only blocks whose first row is
 * all text will name columns from that row — the same tradeoff PIICatcher
 * makes, kept because misnaming costs nothing downstream (classification
 * samples data rows either way).
 */
function isInferredHeader(cells: string[]): boolean {
	return cells.some((c) => c.length > 0) && cells.every((c) => !NUMERIC_CELL.test(c));
}

function columnNames(headerRow: string[] | null, width: number): string[] {
	return Array.from({ length: width }, (_, i) => {
		const cell = headerRow?.[i]?.trim();
		return cell ? cell : `column_${i + 1}`;
	});
}

// ──────────────────────────── line-based run detection ────────────────────────────

interface LineRun {
	startLine: number; // 0-based index into `lines`
	lines: string[];
}

/**
 * Sentence punctuation at end-of-line marks prose, not a CSV row. Excluding
 * such lines keeps ordinary flowing text (clauses separated by commas, ending
 * in a period) from forming spurious "consistent" runs.
 */
function endsSentence(line: string): boolean {
	const t = line.trimEnd();
	return t.endsWith(".") || t.endsWith("!") || t.endsWith("?");
}

/** Maximal consecutive-line runs where every line splits into exactly `k ≥ MIN_COLUMNS` cells. */
function csvRuns(lines: string[], delim: string, consumed: ReadonlySet<number>): LineRun[] {
	const runs: LineRun[] = [];
	let start: number | null = null;
	let width = 0;
	for (let i = 0; i <= lines.length; i++) {
		const line = i < lines.length ? lines[i]! : "";
		const count =
			i < lines.length && !consumed.has(i) && line.includes(delim) && !endsSentence(line)
				? splitCsvLine(line, delim).length
				: 0;
		if (count >= MIN_COLUMNS) {
			if (start === null) {
				start = i;
				width = count;
			} else if (count !== width) {
				// Width changed: close the current run, open a new one here.
				if (i - start >= MIN_RUN_LINES) runs.push({ startLine: start, lines: lines.slice(start, i) });
				start = i;
				width = count;
			}
		} else if (start !== null) {
			if (i - start >= MIN_RUN_LINES) runs.push({ startLine: start, lines: lines.slice(start, i) });
			start = null;
		}
	}
	return runs;
}

/** A separator rule line: dashes/box characters with optional pipes, pluses, colons, spaces. */
function isRuleLine(line: string): boolean {
	const t = line.trim();
	if (t.length === 0) return false;
	if (!/^[\s|+:\-─┼═╪]+$/.test(t)) return false;
	return /-{4,}|─{4,}|={4,}/.test(t);
}

/** A box-drawing data row (contains U+2502). */
function isBoxRow(line: string): boolean {
	return line.includes("│");
}

/** An ASCII pipe-table data row: starts and contains another `|` after trim. */
function isPipeRow(line: string): boolean {
	const t = line.trim();
	return t.startsWith("|") && t.slice(1).includes("|");
}

/** Split a ruled-table data row into cells on its delimiter, trimming outer rails. */
function splitRuledRow(line: string, delim: "│" | "|"): string[] {
	let t = line.trim();
	if (t.startsWith(delim)) t = t.slice(1);
	if (t.endsWith(delim)) t = t.slice(0, -1);
	return t.split(delim).map((c) => c.trim());
}

/** Maximal runs of ruled-table lines (data rows interleaved with rule lines). */
function ruledRuns(lines: string[], consumed: ReadonlySet<number>): Array<LineRun & { delim: "│" | "|" }> {
	const runs: Array<LineRun & { delim: "│" | "|" }> = [];
	let start: number | null = null;
	let boxVotes = 0;
	let asciiVotes = 0;
	for (let i = 0; i <= lines.length; i++) {
		const line = i < lines.length ? lines[i]! : "";
		const isMember =
			i < lines.length &&
			!consumed.has(i) &&
			(isBoxRow(line) || isPipeRow(line) || isRuleLine(line));
		if (isMember) {
			if (start === null) {
				start = i;
				boxVotes = 0;
				asciiVotes = 0;
			}
			if (isBoxRow(line)) boxVotes++;
			else if (isPipeRow(line)) asciiVotes++;
		} else if (start !== null) {
			const slice = lines.slice(start, i);
			const dataRows = slice.filter((l) => !isRuleLine(l)).length;
			if (dataRows >= MIN_RUN_LINES - 1 && dataRows >= 2) {
				runs.push({ startLine: start, lines: slice, delim: boxVotes >= asciiVotes ? "│" : "|" });
			}
			start = null;
		}
	}
	return runs;
}

/** Maximal runs of aligned-column lines: every line splits identically on 2+ spaces. */
function alignedRuns(lines: string[], consumed: ReadonlySet<number>): LineRun[] {
	const runs: LineRun[] = [];
	let start: number | null = null;
	let width = 0;
	for (let i = 0; i <= lines.length; i++) {
		const line = i < lines.length ? lines[i]! : "";
		let count = 0;
		if (i < lines.length && !consumed.has(i) && line.trim().length > 0 && !isRuleLine(line)) {
			const cells = line.trim().split(/\s{2,}/).map((c) => c.trim()).filter((c) => c.length > 0);
			count = cells.length;
		}
		if (count >= MIN_COLUMNS) {
			if (start === null) {
				start = i;
				width = count;
			} else if (count !== width) {
				if (i - start >= MIN_RUN_LINES) runs.push({ startLine: start, lines: lines.slice(start, i) });
				start = i;
				width = count;
			}
		} else if (start !== null) {
			if (i - start >= MIN_RUN_LINES) runs.push({ startLine: start, lines: lines.slice(start, i) });
			start = null;
		}
	}
	return runs;
}

// ──────────────────────────── JSON array detection ────────────────────────────

interface JsonSpan {
	startChar: number;
	endChar: number; // inclusive
}

/** Find balanced `[ … ]` spans that begin an array of objects. String-aware bracket tracking. */
function jsonArraySpans(text: string): JsonSpan[] {
	const spans: JsonSpan[] = [];
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== "[") continue;
		// Only interested in arrays of records: next non-whitespace must be `{`.
		let j = i + 1;
		while (j < text.length && /\s/.test(text[j]!)) j++;
		if (text[j] !== "{") continue;
		// Track depth with string awareness until depth returns to zero.
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let k = i; k < text.length; k++) {
			const ch = text[k]!;
			if (inString) {
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') inString = true;
			else if (ch === "[" || ch === "{") depth++;
			else if (ch === "]" || ch === "}") {
				depth--;
				if (depth === 0) {
					spans.push({ startChar: i, endChar: k });
					i = k; // outer loop resumes after this span
					break;
				}
			}
		}
	}
	return spans;
}

interface HomogeneityCheck {
	ok: boolean;
	keys: string[];
	rows: string[][];
}

/** Parse a span and check it is an array of homogeneous object records. */
function parseHomogeneousRecords(spanText: string): HomogeneityCheck {
	let parsed: unknown;
	try {
		parsed = JSON.parse(spanText);
	} catch {
		// Not valid JSON: not a fragment. Expected control flow, not an error.
		return { ok: false, keys: [], rows: [] };
	}
	if (!Array.isArray(parsed) || parsed.length < MIN_JSON_RECORDS) return { ok: false, keys: [], rows: [] };
	let keys: string[] | null = null;
	const rows: string[][] = [];
	for (const rec of parsed) {
		if (typeof rec !== "object" || rec === null || Array.isArray(rec)) {
			return { ok: false, keys: [], rows: [] };
		}
		const obj = rec as Record<string, unknown>;
		const ks = Object.keys(obj);
		if (ks.length < MIN_COLUMNS) return { ok: false, keys: [], rows: [] };
		if (keys === null) {
			keys = ks;
		} else {
			const a = [...keys].sort().join("\u0000");
			const b = [...ks].sort().join("\u0000");
			if (a !== b) return { ok: false, keys: [], rows: [] };
		}
		rows.push(
			keys.map((k) => {
				const v = obj[k];
				if (v === null || v === undefined) return "";
				if (typeof v === "string") return v.trim();
				if (typeof v === "number" || typeof v === "boolean") return String(v);
				return JSON.stringify(v);
			}),
		);
	}
	return { ok: true, keys: keys ?? [], rows };
}

// ──────────────────────────── top-level detection ────────────────────────────

/**
 * Detect tabular fragments in one message field's text. Pure and
 * deterministic; detection order fixes line consumption (JSON → ruled tables
 * → CSV → aligned columns).
 *
 * @param text the field's full text
 * @param messageId owning message id
 * @param field which message field the text came from
 * @param config resolved analyzer config (format toggles honoured)
 */
export function detectFragments(
	text: string,
	messageId: string,
	field: LeakField,
	config: PiicatcherConfig,
): TabularFragment[] {
	const fragments: TabularFragment[] = [];
	const consumed = new Set<number>();
	const lines = text.split("\n");

	/** Mark a 0-based line range consumed and record the fragment. */
	function claim(run: LineRun, kind: FragmentKind, header: string[], rows: string[][]): void {
		for (let i = run.startLine; i < run.startLine + run.lines.length; i++) consumed.add(i);
		fragments.push({
			kind,
			message_id: messageId,
			field,
			start_line: run.startLine + 1,
			header,
			rows,
		});
	}

	// 1. JSON arrays of homogeneous records.
	if (config.formats.json) {
		for (const span of jsonArraySpans(text)) {
			const check = parseHomogeneousRecords(text.slice(span.startChar, span.endChar + 1));
			if (!check.ok) continue;
			// Which lines does the span touch? Claim them so line-based formats skip it.
			let firstLine = 0;
			let lastLine = lines.length - 1;
			let charCount = 0;
			let seenFirst = false;
			for (let li = 0; li < lines.length; li++) {
				const lineEnd = charCount + lines[li]!.length;
				if (!seenFirst && span.startChar <= lineEnd) {
					firstLine = li;
					seenFirst = true;
				}
				if (span.endChar <= lineEnd) {
					lastLine = li;
					break;
				}
				charCount = lineEnd + 1; // +1 for the newline
			}
			claim(
				{ startLine: firstLine, lines: lines.slice(firstLine, lastLine + 1) },
				"json",
				check.keys,
				check.rows,
			);
		}
	}

	// 2. Ruled SQL result tables (box-drawing and ASCII pipe).
	if (config.formats.sql) {
		for (const run of ruledRuns(lines, consumed)) {
			const dataRows = run.lines
				.filter((l) => !isRuleLine(l))
				.map((l) => splitRuledRow(l, run.delim))
				.filter((cells) => cells.length >= MIN_COLUMNS);
			if (dataRows.length < 2) continue;
			const widths = new Set(dataRows.map((r) => r.length));
			if (widths.size !== 1) continue;
			const width = dataRows[0]!.length;
			const header = isInferredHeader(dataRows[0]!) ? dataRows[0]! : null;
			const rows = header ? dataRows.slice(1) : dataRows;
			if (rows.length < 1) continue;
			claim(run, "sql-table", columnNames(header, width), rows);
		}
	}

	// 3. CSV blocks (delimiter sniffed in fixed order).
	if (config.formats.csv) {
		for (const delim of CSV_DELIMITERS) {
			for (const run of csvRuns(lines, delim, consumed)) {
				const parsed = run.lines.map((l) => splitCsvLine(l, delim));
				const width = parsed[0]!.length;
				const header = isInferredHeader(parsed[0]!) ? parsed[0]! : null;
				const rows = header ? parsed.slice(1) : parsed;
				if (rows.length < 1) continue;
				claim(run, "csv", columnNames(header, width), rows);
			}
		}
	}

	// 4. Aligned plain-text columns.
	if (config.formats.sql) {
		for (const run of alignedRuns(lines, consumed)) {
			const parsed = run.lines.map((l) =>
				l.trim().split(/\s{2,}/).map((c) => c.trim()).filter((c) => c.length > 0),
			);
			const width = parsed[0]!.length;
			const header = isInferredHeader(parsed[0]!) ? parsed[0]! : null;
			const rows = header ? parsed.slice(1) : parsed;
			if (rows.length < 1) continue;
			claim(run, "sql-table", columnNames(header, width), rows);
		}
	}

	return fragments;
}
