/**
 * SecretScanner-style detection: container/filesystem evidence candidates
 * from `extractors.ts` run through (a) the bundled detector catalogues via
 * the shared scanning engine's candidate machinery and (b) a targeted
 * structural check on variable name + value shape.
 *
 * Detection is pure and deterministic. A finding exists when either layer
 * fires:
 *
 * - **Catalogue match** — the candidate's *value* is scanned with
 *   {@link scanFieldCandidates} against the union of the bundled detector
 *   catalogues (secret-leak, gitleaks, Nosey Parker, TruffleHog). The finding
 *   references the catalogue rule family that matched (`rule_id` is the
 *   catalogue id) rather than duplicating any pattern — this analyzer's value
 *   is the extraction layer, not more provider patterns.
 * - **Structural match** — the candidate's *name* matches the configured
 *   sensitive-name pattern AND its value has credential shape (long enough,
 *   no whitespace, mixed letters and digits). This catches credentials no
 *   prefix rule knows: reported as rule id `artifact-sensitive-name`.
 *
 * Values that cannot be leaks are filtered before either layer runs: masked
 * CI values (`****`, `[masked]`), pure `${VAR}` interpolations, placeholder
 * strings, and short values.
 *
 * Redaction invariant: findings carry a redacted preview and a short SHA-256
 * fingerprint of the full value — derived identically to every other detector
 * so the downstream proposal synthesiser can collapse the same leak across
 * detectors by `(credential fingerprint, message_id)`. The raw value never
 * reaches the graph.
 */

import type { MessageRow } from "../../types.js";
import {
	fingerprintOf,
	redact,
	scanFieldCandidates,
	LeakConfidence,
	LeakField,
	LeakSeverity,
	type SecretLeakRule,
} from "../secret-scanner.js";
import { Type, type Static } from "typebox";
import { SECRET_LEAK_RULES } from "../secret-leak/detectors.js";
import { GITLEAKS_RULES } from "../gitleaks/rules.js";
import { NOSEY_PARKER_RULES } from "../nosey-parker/rules.js";
import { TRUFFLEHOG_RULES } from "../trufflehog/rules.js";
import {
	extractArtifactCandidates,
	normalizeFieldText,
	ARTIFACT_KINDS,
	type ArtifactCandidate,
	ArtifactKind,
	type ExtractorToggles,
} from "./extractors.js";
import {
	DEFAULT_SECRET_SCANNER_CONFIG,
	assertKnownRuleIds,
	type SecretScannerConfig,
} from "./config.js";

export { fingerprintOf, redact } from "../secret-scanner.js";
export {
	ARTIFACT_KINDS,
	type ArtifactCandidate,
	ArtifactKind,
	type ExtractorToggles,
} from "./extractors.js";
export {
	DEFAULT_SECRET_SCANNER_CONFIG,
	assertKnownRuleIds,
	SecretScannerConfigSchema,
	type SecretScannerConfig,
} from "./config.js";

// ──────────────────────────── catalogue ────────────────────────────

/**
 * The union of the bundled detector catalogues, deduplicated by rule id
 * (first occurrence wins). Scanning a candidate value against this union
 * means a finding always names the strongest existing rule family — no
 * pattern here is duplicated from anywhere.
 */
export const ARTIFACT_CATALOGUE_RULES: readonly SecretLeakRule[] = (() => {
	const seen = new Set<string>();
	const out: SecretLeakRule[] = [];
	for (const rule of [...SECRET_LEAK_RULES, ...GITLEAKS_RULES, ...NOSEY_PARKER_RULES, ...TRUFFLEHOG_RULES]) {
		if (seen.has(rule.id)) continue;
		seen.add(rule.id);
		out.push(rule);
	}
	return out;
})();

/** Catalogue rule ids, for config validation. */
export const ARTIFACT_CATALOGUE_RULE_IDS: readonly string[] = ARTIFACT_CATALOGUE_RULES.map((r) => r.id);

/** Rule id for structural (name + shape) findings — this analyzer's own rule. */
export const STRUCTURAL_RULE_ID = "artifact-sensitive-name";

// ──────────────────────────── value filters ────────────────────────────

/** Masked/hidden values: proof a secret existed, not a leak of it. */
const MASKED_VALUE_RE = /^(\*{3,}|•{3,}|x{8,}|X{8,}|\[*\b(?:masked|hidden|redacted)\b\]*)$/i;
/** Pure interpolation: `$OTHER` / `${OTHER}` — a reference, not a value. */
const INTERPOLATION_RE = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/;
/** Documentation placeholders, in the common shapes. */
const PLACEHOLDER_RE =
	/^(your[_-]?.*|my[_-]?.*|changeme|change[-_]me|example[-_].*|placeholder|<[^>]+>|\$\{[^}]*\}|\*{2,}|xxx+|dummy|sample[-_]?.*|insert[_-].*)$/i;

/**
 * Does the raw candidate value have credential *shape*? Deliberately
 * conservative: long enough, single-token (no whitespace), and mixing letters
 * with digits — the shape of generated credentials, not of prose or paths.
 */
export function hasCredentialShape(value: string, minLength: number): boolean {
	return (
		value.length >= minLength &&
		value.length <= 512 &&
		!/\s/.test(value) &&
		/[A-Za-z]/.test(value) &&
		/[0-9]/.test(value)
	);
}

/** Can this candidate value possibly be a reported leak? */
function isReportableValue(value: string, minLength: number): boolean {
	const v = value.trim();
	if (v.length === 0) return false;
	if (MASKED_VALUE_RE.test(v)) return false;
	if (INTERPOLATION_RE.test(v)) return false;
	if (PLACEHOLDER_RE.test(v)) return false;
	// Filesystem paths are not credential-shaped even when they contain digits.
	if (v.startsWith("/")) return false;
	return true;
}

// ──────────────────────────── detection ────────────────────────────

/** Which message field a finding came from (mirrors the shared engine's set). */
export type ScannerField = LeakField;

/** One leak found inside a container/filesystem artifact context. */
export const SecretScannerFinding = Type.Object({
	/**
	 * The rule that fired: a catalogue rule family id when a catalogue rule
	 * matched the value, or `artifact-sensitive-name` for a structural match.
	 */
	rule_id: Type.String(),
	/** Human-readable rule label. */
	rule_label: Type.String(),
	/** Severity (the catalogue rule's own, or `high` for structural matches). */
	severity: LeakSeverity,
	/** Confidence (`active` for structural matches: name + shape confirm context). */
	confidence: LeakConfidence,
	/** Message id the artifact evidence appeared in. */
	message_id: Type.String(),
	/** Which message field contained the artifact text. */
	field: LeakField,
	/** The artifact context the value was extracted from. */
	artifact_kind: ArtifactKind,
	/** Where it lived, e.g. "ENV in Dockerfile", ".env entry", "shell export". */
	artifact_location: Type.String(),
	/** The variable/entry name (names are configuration, not secrets). */
	key_name: Type.String(),
	/** First/last characters of the matched value, middle truncated. Never the full secret. */
	redacted_preview: Type.String(),
	/** Short SHA-256 fingerprint of the full value — dedup/allowlist key across detectors. */
	fingerprint: Type.String(),
	/** Character offset of the assignment within the field text. */
	match_index: Type.Number(),
	/** Byte length of the matched value. */
	match_length: Type.Number(),
});
export type SecretScannerFinding = Static<typeof SecretScannerFinding>;

export const SecretScannerScanResult = Type.Object({
	/** Total findings, after allowlisting and per-field capping. */
	leak_count: Type.Number(),
	/** The findings, capped at `maxMatchesPerField` per field. */
	leaks: Type.Array(SecretScannerFinding),
	/** Count of matches dropped for exceeding `maxMatchesPerField` per field. */
	truncated_matches: Type.Number(),
	/** Count of matches dropped by the allowlist (fingerprint or pattern). */
	allowlisted_matches: Type.Number(),
	/** Findings per rule id. */
	rule_counts: Type.Record(Type.String(), Type.Number()),
	/** Findings per artifact kind. */
	artifact_counts: Type.Record(Type.String(), Type.Number()),
	/** Distinct message ids that contained at least one leak. */
	affected_message_ids: Type.Array(Type.String()),
});
export type SecretScannerScanResult = Static<typeof SecretScannerScanResult>;


/** The fields scanned, mirroring the shared engine's SCAN_FIELDS order. */
const SCAN_FIELDS: ReadonlyArray<{ row: keyof MessageRow; label: LeakField }> = [
	{ row: "content_text", label: "content_text" },
	{ row: "content_thinking", label: "content_thinking" },
	{ row: "tool_calls", label: "tool_calls" },
	{ row: "tool_results", label: "tool_results" },
];

function togglesOf(config: SecretScannerConfig): ExtractorToggles {
	return {
		extractDockerfiles: config.extractDockerfiles,
		extractDotenv: config.extractDotenv,
		extractBuildLogs: config.extractBuildLogs,
		extractCiLogs: config.extractCiLogs,
		extractShellExports: config.extractShellExports,
	};
}

/** Severity rank used to pick the strongest catalogue match for a value. */
const SEVERITY_RANK: Record<LeakSeverity, number> = { medium: 1, high: 2, critical: 3 };
const CONFIDENCE_RANK: Record<LeakConfidence, number> = { passive: 1, active: 2 };

/**
 * Detect secrets in container/filesystem artifact contexts across a session's
 * messages. Pure and deterministic.
 *
 * @param messages the session's message rows, in order
 * @param config the resolved analyzer config (defaults applied for missing keys)
 */
export function detectArtifactLeaks(
	messages: readonly MessageRow[],
	config: SecretScannerConfig = DEFAULT_SECRET_SCANNER_CONFIG,
): SecretScannerScanResult {
	assertKnownRuleIds(config);
	const disabled = new Set(config.disabledRules);
	const allowFp = new Set(config.allowFingerprints);
	const allowPatterns = config.allowPatterns.map((src) => new RegExp(src, "u"));
	const maxPerField = config.maxMatchesPerField;
	const sensitiveName = new RegExp(config.sensitiveNamePattern, "i");
	const toggles = togglesOf(config);

	const leaks: SecretScannerFinding[] = [];
	let truncated = 0;
	let allowlisted = 0;
	const ruleCounts: Record<string, number> = {};
	const artifactCounts = Object.fromEntries(ARTIFACT_KINDS.map((k) => [k, 0])) as Record<
		ArtifactKind,
		number
	>;
	const affected = new Set<string>();

	for (const m of messages) {
		for (const { row, label } of SCAN_FIELDS) {
			const raw = m[row];
			if (typeof raw !== "string" || raw.length === 0) continue;

			let emitted = 0;
			// Unfold JSON string escapes so line-anchored extractors see real line
			// breaks in `tool_calls`/`tool_results`; candidate offsets map back to
			// the raw field text.
			const { text, map } = normalizeFieldText(raw);
			for (const cand of extractArtifactCandidates(text, toggles)) {
				const rawIndex = map[cand.index] ?? cand.index;
				if (!isReportableValue(cand.value, config.minCredentialLength)) continue;

				// Layer 1: catalogue families over the extracted value alone.
				const catalogueHits = scanFieldCandidates(cand.value, ARTIFACT_CATALOGUE_RULES).filter(
					(h) => !disabled.has(h.rule.id),
				);
				// Layer 2: structural name + shape check.
				const structural =
					!disabled.has(STRUCTURAL_RULE_ID) &&
					sensitiveName.test(cand.key) &&
					hasCredentialShape(cand.value, config.minCredentialLength);

				if (catalogueHits.length === 0 && !structural) continue;

				const primary = catalogueHits
					.slice()
					.sort(
						(a, b) =>
							SEVERITY_RANK[b.rule.severity] - SEVERITY_RANK[a.rule.severity] ||
							CONFIDENCE_RANK[(b.rule.confidence ?? "passive")] -
								CONFIDENCE_RANK[(a.rule.confidence ?? "passive")] ||
							a.rule.id.localeCompare(b.rule.id),
					)[0];

				const fp = fingerprintOf(cand.value);
				if (allowFp.has(fp) || allowPatterns.some((re) => re.test(cand.value))) {
					allowlisted++;
					continue;
				}
				if (emitted >= maxPerField) {
					truncated++;
					continue;
				}

				leaks.push({
					rule_id: primary ? primary.rule.id : STRUCTURAL_RULE_ID,
					rule_label: primary ? primary.rule.label : "Sensitive-named variable with credential-shaped value",
					severity: primary ? primary.rule.severity : "high",
					confidence: primary ? (primary.rule.confidence ?? "passive") : "active",
					message_id: m.id,
					field: label,
					artifact_kind: cand.kind,
					artifact_location: cand.location,
					key_name: cand.key,
					redacted_preview: redact(cand.value),
					fingerprint: fp,
					match_index: rawIndex,
					match_length: cand.value.length,
				});
				const rid = primary ? primary.rule.id : STRUCTURAL_RULE_ID;
				ruleCounts[rid] = (ruleCounts[rid] ?? 0) + 1;
				artifactCounts[cand.kind] = (artifactCounts[cand.kind] ?? 0) + 1;
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
		artifact_counts: artifactCounts,
		affected_message_ids: [...affected].sort(),
	};
}

/** Convenience for tests: extract candidates from one text with default toggles. */
export function extractWithDefaults(text: string): ArtifactCandidate[] {
	return extractArtifactCandidates(text, {
		extractDockerfiles: true,
		extractDotenv: true,
		extractBuildLogs: true,
		extractCiLogs: true,
		extractShellExports: true,
	});
}
