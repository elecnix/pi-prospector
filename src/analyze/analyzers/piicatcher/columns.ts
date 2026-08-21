/**
 * Column-semantics classification: segment a tabular fragment into logical
 * columns and judge each column by sampling its values.
 *
 * This is PIICatcher's distinctive contribution (issue #174): frequency and
 * shape analysis over a *column*, not repeated single-value scanning. Each
 * column's sensitivity is the fraction of sampled values whose shape matches
 * a sensitive recognizer; above the configured threshold the column itself is
 * the finding — "column 'email' in CSV block: 9/10 values match email-address"
 * — because a column whose values overwhelmingly match email shapes IS an
 * email column, while one email among ten names is not.
 *
 * Per-value classification **reuses the presidio analyzer's recognizer stack**
 * (`PII_RECOGNIZERS`, `judge` from `../presidio/recognizers.js`). That is a
 * code-organisation decision, not an analysis dependency: these are pure
 * functions with no node output, so dependency-scoped visibility does not
 * apply — this analyzer consumes none of presidio's analysis nodes and
 * declares no dependency on it. Sharing the recognizers is what keeps every
 * detector in the stack agreeing about what an email or a card number is.
 *
 * Determinism: fixed sampling order (top-down through data rows), fixed
 * recognizer order (registry order), fixed tie-breaking (highest score, then
 * registry order). Same input ⇒ same findings.
 */

import { PII_RECOGNIZERS, judge } from "../presidio/recognizers.js";
import { fingerprintOf, redact, type LeakField } from "../secret-scanner.js";
import type { PiicatcherConfig } from "./config.js";
import type { TabularFragment } from "./fragments.js";

/** One column-level finding. Never carries the full matched value. */
export interface ColumnFinding {
	/** Fragment kind the column came from (`csv` | `json` | `sql-table`). */
	fragment_kind: TabularFragment["kind"];
	/** 1-based line the fragment starts on within its message field. */
	fragment_start_line: number;
	/** Ordinal of the fragment within its message field (detection order). */
	fragment_index: number;
	/** Column name: inferred header cell or `column_N`. */
	column_name: string;
	/** Message id carrying the fragment. */
	message_id: string;
	/** Which message field contained the fragment. */
	field: LeakField;
	/** Number of non-empty values sampled (≤ `sampleSizePerColumn`). */
	sample_size: number;
	/** Sampled values that matched a sensitive shape above the score floor. */
	match_count: number;
	/** `match_count / sample_size`. */
	match_ratio: number;
	/** Entity types matched, with per-type counts over the sample. */
	entity_types: Record<string, number>;
	/** Redacted preview of the first matching value (sample order). */
	redacted_preview: string;
	/** Short SHA-256 fingerprint of that value — dedup/allow/deny key. */
	fingerprint: string;
}

export interface ColumnClassificationResult {
	findings: ColumnFinding[];
	/** Columns examined for this fragment. */
	columns_classified: number;
	/** Columns whose ratio reached the threshold but found nothing to report (no matches at all). */
	columns_below_threshold: number;
	/** Values skipped because their fingerprint was allowlisted (or matched an allow pattern). */
	allowlisted_values: number;
}

/**
 * Classify one value against the shipped recognizer registry.
 *
 * Returns the best judgement (highest score; ties broken by registry order),
 * or undefined when no recognizer matches or every match fails a mandatory
 * checksum. When `minScore` is given, judgements below the floor are filtered
 * — column classification omits it so deny-listed values can bypass the
 * floor.
 */
export function classifyValue(
	value: string,
	minScore?: number,
	recognizers: readonly typeof PII_RECOGNIZERS[number][] = PII_RECOGNIZERS,
): { entity_type: string; score: number; matched_text: string } | undefined {
	let best: { entity_type: string; score: number; matched_text: string } | undefined;
	for (const rec of recognizers) {
		for (const pattern of rec.patterns) {
			// Clone so the registry's shared regex objects never carry lastIndex.
			const re = new RegExp(pattern.source, pattern.flags);
			for (const m of value.matchAll(re)) {
				const text = m[0];
				const judgement = judge(rec, text, true);
				if (!judgement) continue; // mandatory checksum failure: not a match
				if (minScore !== undefined && judgement.score < minScore) continue;
				if (!best || judgement.score > best.score) {
					best = { entity_type: rec.entityType, score: judgement.score, matched_text: text };
				}
			}
		}
	}
	return best;
}

/**
 * Classify every column of one fragment by value sampling. Pure and
 * deterministic.
 */
export function classifyFragment(
	fragment: TabularFragment,
	config: PiicatcherConfig,
): ColumnClassificationResult {
	const allowFp = new Set(config.allowFingerprints);
	const denyFp = new Set(config.denyFingerprints);
	const allowPatterns = config.allowPatterns.map((src) => new RegExp(src, "u"));

	const width = fragment.header.length;
	const findings: ColumnFinding[] = [];
	let allowlistedValues = 0;

	for (let col = 0; col < width; col++) {
		// Fixed sampling order: top-down through data rows. Empty values are
		// sampled too and count in the denominator — a sparse column with one
		// email among blanks is not "an email column" any more than one email
		// among ten names would be.
		const sample: string[] = [];
		for (const row of fragment.rows) {
			if (sample.length >= config.sampleSizePerColumn) break;
			sample.push(row[col]?.trim() ?? "");
		}
		if (sample.length === 0) continue;

		let matchCount = 0;
		const entityTypes: Record<string, number> = {};
		let representative: { preview: string; fingerprint: string } | null = null;

		for (const value of sample) {
			if (value.length === 0) continue; // empty: denominator only
			// No floor here: a deny-listed value must surface even below it.
			const judged = classifyValue(value);
			if (!judged) continue;
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

		const ratio = matchCount / sample.length;
		if (matchCount === 0 || ratio < config.sensitivityThreshold) continue;
		if (representative === null) continue; // unreachable: matchCount > 0 implies a representative

		findings.push({
			fragment_kind: fragment.kind,
			fragment_start_line: fragment.start_line,
			fragment_index: 0, // filled in by the scan once field-level ordinals are known
			column_name: fragment.header[col] ?? `column_${col + 1}`,
			message_id: fragment.message_id,
			field: fragment.field,
			sample_size: sample.length,
			match_count: matchCount,
			match_ratio: ratio,
			entity_types: entityTypes,
			redacted_preview: representative.preview,
			fingerprint: representative.fingerprint,
		});
	}

	return {
		findings,
		columns_classified: width,
		columns_below_threshold: width - findings.length,
		allowlisted_values: allowlistedValues,
	};
}
