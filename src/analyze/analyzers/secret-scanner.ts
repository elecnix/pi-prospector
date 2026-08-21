/**
 * Shared deterministic secret-scanning engine.
 *
 * Every detector analyzer (`secret-leak`, `gitleaks`, …) scans the same four
 * message fields with the same rule shape, the same redaction, and the same
 * fingerprint derivation. Sharing the engine is load-bearing, not convenience:
 * the single-proposal-per-leak contract groups findings across detectors by
 * `(credential fingerprint, message_id)`, which only works if every detector
 * derives the fingerprint of a matched value identically.
 *
 * No scanner stores the matched secret. A finding carries a **redacted
 * preview** (first and last few characters) and a **fingerprint** (short
 * SHA-256 of the full value), so a secret is recognisable and dedupable across
 * sessions without the analysis graph ever holding the credential itself. The
 * graph is durable and widely readable, so it must not become a second leak.
 */

import type { MessageRow } from "../types.js";
import { shortHash } from "../input-hash.js";

// ──────────────────────────── rules ────────────────────────────

export type LeakSeverity = "medium" | "high" | "critical";

export interface SecretLeakRule {
	id: string;
	label: string;
	severity: LeakSeverity;
	/**
	 * Anchored, high-precision pattern. Must include the `g` flag for matchAll.
	 * Patterns deliberately avoid bare high-entropy heuristics, which produce
	 * unmanageable false positives in free-form session text. A rule whose
	 * secret is a capture group (group 1) declares the secret via the group;
	 * the whole match is used otherwise.
	 */
	pattern: RegExp;
}

/** Which message field a secret was found in. */
export type LeakField = "content_text" | "content_thinking" | "tool_calls" | "tool_results";

export interface SecretLeakFinding {
	/** The rule that matched. */
	rule_id: string;
	/** Human-readable rule label. */
	rule_label: string;
	/** Rule severity. */
	severity: LeakSeverity;
	/** Message id the leak appeared in. */
	message_id: string;
	/** Which message field contained the leak. */
	field: LeakField;
	/**
	 * First and last few characters of the matched value, middle truncated.
	 * Never the full secret.
	 */
	redacted_preview: string;
	/**
	 * Short SHA-256 fingerprint (16 hex chars) of the full matched value, for
	 * deduplication and allowlisting without storing the secret.
	 */
	fingerprint: string;
	/** Character offset of the match within the field (for `prospect show`). */
	match_index: number;
	/**
	 * Byte length of the matched value, so the magnitude is visible without the
	 * content. For capture-group rules this is the captured group length.
	 */
	match_length: number;
}

export interface SecretLeakScanResult {
	/** Total findings, after allowlisting and severity filtering. */
	leak_count: number;
	/** The findings, capped at `maxMatchesPerField` per field. */
	leaks: SecretLeakFinding[];
	/** Count of matches dropped for exceeding `maxMatchesPerField` in a field. */
	truncated_matches: number;
	/** Count of matches dropped by the allowlist (fingerprint or pattern). */
	allowlisted_matches: number;
	/** Findings per rule id. */
	rule_counts: Record<string, number>;
	/** Distinct message ids that contained at least one leak. */
	affected_message_ids: string[];
}

/**
 * The config surface every detector analyzer exposes. Structurally satisfied
 * by each analyzer's TypeBox config schema (`SecretLeakConfig`,
 * `GitleaksConfig`, …), so the engine stays decoupled from any one schema.
 */
export interface RuleScanConfig {
	/** Rule ids to skip entirely. */
	disabledRules: string[];
	/** Short SHA-256 fingerprints of matched values to ignore. */
	allowFingerprints: string[];
	/** Regex sources tested against a matched value; a match is ignored. */
	allowPatterns: string[];
	/** Maximum matches recorded per message field. */
	maxMatchesPerField: number;
	/** Lowest severity to report. */
	minSeverity: LeakSeverity;
}

/** Severity rank used to compare against `minSeverity`. */
export const SEVERITY_RANK: Record<LeakSeverity, number> = {
	medium: 1,
	high: 2,
	critical: 3,
};

/** Does `sev` meet the configured `minSeverity` floor? */
export function meetsMinSeverity(sev: LeakSeverity, minSeverity: LeakSeverity): boolean {
	return SEVERITY_RANK[sev] >= SEVERITY_RANK[minSeverity];
}

// ──────────────────────────── redaction ────────────────────────────

/** SHA-256 prefix of the full matched value — the dedup/allowlist key. */
export function fingerprintOf(value: string): string {
	return shortHash(`leak(${value})`);
}

/**
 * Redact a matched value to a first/last preview. For short values, fully
 * masked. Never exposes the middle of a credential.
 */
export function redact(value: string): string {
	if (value.length <= 8) return "••••";
	if (value.length <= 16) return `${value.slice(0, 2)}••••${value.slice(-2)}`;
	return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

// ──────────────────────────── scanning ────────────────────────────

/** Fields of a MessageRow to scan, with their LeakField label. */
const SCAN_FIELDS: ReadonlyArray<{ row: keyof MessageRow; label: LeakField }> = [
	{ row: "content_text", label: "content_text" },
	{ row: "content_thinking", label: "content_thinking" },
	{ row: "tool_calls", label: "tool_calls" },
	{ row: "tool_results", label: "tool_results" },
];

/**
 * The value a rule match contributes. For rules with a capture group (e.g. an
 * assignment-context rule) the secret is group 1; otherwise it is the whole
 * match.
 */
function matchedSecret(match: RegExpMatchArray): string {
	return match[1] ?? match[0];
}

/**
 * Scan a single text field for all rule matches. A fresh regex is cloned per
 * field so the shared catalogue's `lastIndex` never leaks between calls.
 */
function scanField(
	text: string,
	rules: readonly SecretLeakRule[],
): Array<{ rule: SecretLeakRule; value: string; index: number }> {
	const out: Array<{ rule: SecretLeakRule; value: string; index: number }> = [];
	for (const rule of rules) {
		// matchAll requires a global regex; clone so catalogue state is untouched.
		const re = new RegExp(rule.pattern.source, rule.pattern.flags);
		for (const m of text.matchAll(re)) {
			out.push({ rule, value: matchedSecret(m), index: m.index ?? 0 });
		}
	}
	// Stable order: by index then rule id, so findings read left-to-right.
	out.sort((a, b) => (a.index - b.index) || a.rule.id.localeCompare(b.rule.id));
	return out;
}

/**
 * Detect secret leaks across a session's messages with the given rule
 * catalogue. Pure and deterministic.
 *
 * @param messages the session's message rows, in order
 * @param rules the catalogue to scan with
 * @param config the resolved analyzer config (defaults applied for missing keys)
 */
export function scanMessages(
	messages: readonly MessageRow[],
	rules: readonly SecretLeakRule[],
	config: RuleScanConfig,
): SecretLeakScanResult {
	const disabled = new Set(config.disabledRules);
	const allowFp = new Set(config.allowFingerprints);
	const allowPatterns = config.allowPatterns.map((src) => new RegExp(src, "u"));
	const maxPerField = config.maxMatchesPerField;

	// Filter to enabled, min-severity rules. Keep catalogue order for determinism.
	const activeRules = rules.filter(
		(r) => !disabled.has(r.id) && meetsMinSeverity(r.severity, config.minSeverity),
	);

	const leaks: SecretLeakFinding[] = [];
	let truncated = 0;
	let allowlisted = 0;
	const ruleCounts: Record<string, number> = {};
	const affected = new Set<string>();

	for (const m of messages) {
		for (const { row, label } of SCAN_FIELDS) {
			const raw = m[row];
			if (typeof raw !== "string" || raw.length === 0) continue;

			const hits = scanField(raw, activeRules);

			// Cap per field; record how many were dropped.
			let emitted = 0;
			for (const hit of hits) {
				if (emitted >= maxPerField) {
					truncated += hits.length - emitted;
					break;
				}
				const fp = fingerprintOf(hit.value);
				if (allowFp.has(fp)) {
					allowlisted++;
					continue;
				}
				if (allowPatterns.some((re) => re.test(hit.value))) {
					allowlisted++;
					continue;
				}
				leaks.push({
					rule_id: hit.rule.id,
					rule_label: hit.rule.label,
					severity: hit.rule.severity,
					message_id: m.id,
					field: label,
					redacted_preview: redact(hit.value),
					fingerprint: fp,
					match_index: hit.index,
					match_length: hit.value.length,
				});
				ruleCounts[hit.rule.id] = (ruleCounts[hit.rule.id] ?? 0) + 1;
				affected.add(m.id);
				emitted++;
			}
		}
	}

	return {
		leak_count: leaks.length,
		leaks,
		truncated_matches: truncated,
		allowlisted_matches: allowlisted,
		rule_counts: ruleCounts,
		affected_message_ids: [...affected].sort(),
	};
}

/**
 * Convenience: scan a single string against a catalogue and return the rule
 * ids that matched. Used by unit tests; not called on the hot path.
 */
export function matchedRuleIdsFor(rules: readonly SecretLeakRule[], text: string): string[] {
	const ids = new Set<string>();
	for (const rule of rules) {
		const re = new RegExp(rule.pattern.source, rule.pattern.flags);
		if (re.test(text)) ids.add(rule.id);
		// Reset lastIndex in case the shared flag-bearing regex was stateful.
		re.lastIndex = 0;
	}
	return [...ids].sort();
}
