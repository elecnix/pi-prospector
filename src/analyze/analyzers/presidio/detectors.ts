/**
 * Presidio-method PII detection over a session's message stream.
 *
 * Pure and deterministic. Each recognizer's patterns generate candidates per
 * message field; each candidate is judged (checksum / validity rules /
 * low-sensitivity classification), then filtered through the deny list, the
 * allowlist, and the score floor, and capped per field.
 *
 * Fingerprint discipline is shared with the secret detectors: a finding
 * carries a redacted preview and the same short SHA-256 fingerprint
 * (`fingerprintOf`) the other detectors derive for a matched value — that is
 * what makes the single-proposal-per-leak contract's `(credential
 * fingerprint, message_id)` grouping work across detectors. The matched value
 * itself is never stored.
 *
 * Note on candidate generation: this module walks its own candidate stream
 * rather than reusing the shared engine's `scanFieldCandidates`, because that
 * helper treats capture group 1 as the matched value (an assignment-context
 * convention the PII patterns don't follow) and types severity as the secret
 * scale (no `low`). The load-bearing part of the shared engine — fingerprint
 * derivation via `fingerprintOf` and `redact` — *is* reused directly.
 */

import type { MessageRow } from "../../types.js";
import { fingerprintOf, redact, type LeakField } from "../secret-scanner.js";
import {
	PII_RECOGNIZERS,
	judge,
	type PiiRecognizer,
	type PiiSeverity,
} from "./recognizers.js";
import {
	DEFAULT_PRESIDIO_CONFIG,
	assertKnownEntityTypes,
	type PresidioConfig,
} from "./config.js";

export { fingerprintOf, redact } from "../secret-scanner.js";
export {
	DEFAULT_PRESIDIO_CONFIG,
	assertKnownEntityTypes,
	PresidioConfigSchema,
	type PresidioConfig,
} from "./config.js";
export {
	PII_RECOGNIZERS,
	PII_ENTITY_TYPES,
	PII_SEVERITY_RANK,
	luhnValid,
	ibanMod97Valid,
	ssnValid,
	isPrivateIPv4,
	isLowSensitivityIPv6,
	coordinatesValid,
	judge,
	type PiiEntityType,
	type PiiSeverity,
	type PiiRecognizer,
} from "./recognizers.js";

/** One detected PII occurrence. Never carries the full matched value. */
export interface PiiFinding {
	/** Recognizer that matched. */
	recognizer_id: string;
	/** Presidio-style entity label. */
	entity_type: string;
	/** Human-readable recognizer label. */
	entity_label: string;
	/** Finding severity. */
	severity: PiiSeverity;
	/** Confidence 0..1 (Presidio-style). */
	score: number;
	/** True when the recognizer's validator confirmed the value (or none exists). */
	validated: boolean;
	/** True when the value was deny-listed (flagged regardless of score/allowlist). */
	denied: boolean;
	/** Message id the value appeared in. */
	message_id: string;
	/** Which message field contained the value. */
	field: LeakField;
	/** First/last few characters, middle truncated. Never the full value. */
	redacted_preview: string;
	/** Short SHA-256 fingerprint of the full value — dedup/allow/deny key. */
	fingerprint: string;
	/** Character offset of the match within the field (for `prospect show`). */
	match_index: number;
	/** Length of the matched value, so magnitude is visible without content. */
	match_length: number;
}

export interface PiiScanResult {
	/** Total findings, after deny/allow/score filtering and capping. */
	pii_count: number;
	/** The findings, capped at `maxMatchesPerField` per field. */
	piis: PiiFinding[];
	/** Matches dropped for exceeding `maxMatchesPerField` in a field. */
	truncated_matches: number;
	/** Matches dropped by the allowlist (fingerprint or pattern). */
	allowlisted_matches: number;
	/** Matches below the configured `minScore` floor (deny-listed values excepted). */
	below_score_matches: number;
	/** Candidates dropped by a mandatory checksum validator. */
	invalid_matches: number;
	/** Candidates subsumed by a longer overlapping match (e.g. an IBAN's digit tail outscoring a spurious card match). */
	overlap_matches: number;
	/** Findings per entity type. */
	entity_counts: Record<string, number>;
	/** Distinct message ids that contained at least one finding. */
	affected_message_ids: string[];
}

/** Fields of a MessageRow to scan, mirroring the shared engine's field set. */
const SCAN_FIELDS: ReadonlyArray<{ row: keyof MessageRow; label: LeakField }> = [
	{ row: "content_text", label: "content_text" },
	{ row: "content_thinking", label: "content_thinking" },
	{ row: "tool_calls", label: "tool_calls" },
	{ row: "tool_results", label: "tool_results" },
];

interface Candidate {
	rec: PiiRecognizer;
	value: string;
	index: number;
}

/** Walk one text field with every enabled recognizer's patterns. Deterministic order. */
function fieldCandidates(text: string, recognizers: readonly PiiRecognizer[]): Candidate[] {
	const out: Candidate[] = [];
	for (const rec of recognizers) {
		for (const pattern of rec.patterns) {
			// Clone so the registry's shared regex objects never carry lastIndex.
			const re = new RegExp(pattern.source, pattern.flags);
			for (const m of text.matchAll(re)) {
				out.push({ rec, value: m[0], index: m.index ?? 0 });
			}
		}
	}
	// Deduplicate identical candidates when two of a recognizer's own patterns
	// agree on the same span.
	const seen = new Set<string>();
	const deduped = out.filter((c) => {
		const key = `${c.rec.id}\u0000${c.index}\u0000${c.value}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	// Stable order: left-to-right, longest first (more specific match wins),
	// then recognizer id.
	deduped.sort(
		(a, b) =>
			a.index - b.index ||
			b.value.length - a.value.length ||
			a.rec.id.localeCompare(b.rec.id),
	);
	return deduped;
}

/**
 * Detect PII across a session's messages with the shipped recognizer
 * registry. Pure and deterministic.
 *
 * @param messages the session's message rows, in order
 * @param config the resolved analyzer config (defaults applied for missing keys)
 * @param recognizers override the registry (tests); defaults to all shipped recognizers
 */
export function detectPii(
	messages: readonly MessageRow[],
	config: PresidioConfig = DEFAULT_PRESIDIO_CONFIG,
	recognizers: readonly PiiRecognizer[] = PII_RECOGNIZERS,
): PiiScanResult {
	assertKnownEntityTypes(config);

	const wanted = new Set(config.entityTypes);
	const active = recognizers.filter((r) => wanted.size === 0 || wanted.has(r.entityType));
	const allowFp = new Set(config.allowFingerprints);
	const denyFp = new Set(config.denyFingerprints);
	const allowPatterns = config.allowPatterns.map((src) => new RegExp(src, "u"));

	const findings: PiiFinding[] = [];
	let truncated = 0;
	let allowlisted = 0;
	let belowScore = 0;
	let invalid = 0;
	let overlapped = 0;
	const entityCounts: Record<string, number> = {};
	const affected = new Set<string>();

	for (const m of messages) {
		for (const { row, label } of SCAN_FIELDS) {
			const raw = m[row];
			if (typeof raw !== "string" || raw.length === 0) continue;

			const hits = fieldCandidates(raw, active);

			// Judge every candidate first, dropping mandatory-checksum failures.
			const judged: Array<{ hit: Candidate; judgement: NonNullable<ReturnType<typeof judge>>; end: number }> = [];
			for (const hit of hits) {
				const judgement = judge(hit.rec, hit.value, config.validatorsEnabled);
				if (!judgement) {
					// Mandatory checksum failure: not a finding (Presidio's precision trick).
					invalid++;
					continue;
				}
				// Overlap resolution: candidates are ordered left-to-right, longest
				// first, so a spanning match (e.g. an IBAN over the digit tail a
				// card pattern saw) subsumes the shorter one instead of both firing.
				const end = hit.index + hit.value.length;
				const prev = judged[judged.length - 1];
				if (prev && hit.index < prev.end) {
					overlapped++;
					continue;
				}
				judged.push({ hit, judgement, end });
			}

			let emitted = 0;
			for (let h = 0; h < judged.length; h++) {
				const { hit, judgement } = judged[h]!;
				const fp = fingerprintOf(hit.value);
				const denied = denyFp.has(fp);
				if (!denied) {
					if (allowFp.has(fp) || allowPatterns.some((re) => re.test(hit.value))) {
						allowlisted++;
						continue;
					}
					if (judgement.score < config.minScore) {
						belowScore++;
						continue;
					}
				}
				if (emitted >= config.maxMatchesPerField) {
					truncated += judged.length - h;
					break;
				}
				findings.push({
					recognizer_id: hit.rec.id,
					entity_type: hit.rec.entityType,
					entity_label: hit.rec.label,
					severity: judgement.severity,
					score: judgement.score,
					validated: judgement.validated,
					denied,
					message_id: m.id,
					field: label,
					redacted_preview: redact(hit.value),
					fingerprint: fp,
					match_index: hit.index,
					match_length: hit.value.length,
				});
				entityCounts[hit.rec.entityType] = (entityCounts[hit.rec.entityType] ?? 0) + 1;
				affected.add(m.id);
				emitted++;
			}
		}
	}

	return {
		pii_count: findings.length,
		piis: findings,
		truncated_matches: truncated,
		allowlisted_matches: allowlisted,
		below_score_matches: belowScore,
		invalid_matches: invalid,
		overlap_matches: overlapped,
		entity_counts: entityCounts,
		affected_message_ids: [...affected].sort(),
	};
}
