/**
 * Secret-leak detectors.
 *
 * Pure functions operating on a session's message stream. Each detector is a
 * catalogue entry: a rule id, a label, a severity, and an anchored regular
 * expression tuned for **high precision** — the patterns require a
 * provider-specific prefix or structure that ordinary prose does not contain, so
 * a flagged match is very likely a real credential.
 *
 * No detector stores the matched secret. A finding carries a **redacted
 * preview** (first and last few characters) and a **fingerprint** (short
 * SHA-256 of the full value), so a secret is recognisable and dedupable across
 * sessions without the analysis graph ever holding the credential itself. This
 * is the same shape gitleaks uses to report without exposing: the graph is
 * durable and widely readable, so it must not become a second leak.
 */

import type { MessageRow } from "../../types.js";
import { shortHash } from "../../input-hash.js";
import {
	DEFAULT_SECRET_LEAK_CONFIG,
	type LeakSeverity,
	type SecretLeakConfig,
	meetsMinSeverity,
} from "./config.js";

// ──────────────────────────── rule catalogue ────────────────────────────

export interface SecretLeakRule {
	id: string;
	label: string;
	severity: LeakSeverity;
	/**
	 * Anchored, high-precision pattern. Must include the `g` flag for matchAll.
	 * Patterns deliberately avoid bare high-entropy heuristics, which produce
	 * unmanageable false positives in free-form session text.
	 */
	pattern: RegExp;
}

/**
 * The built-in rule catalogue. Ordered roughly by provider. Each entry targets
 * a credential format with a provider-anchored prefix or a structural marker
 * (PEM header, JWT three-part shape) that ordinary text does not match.
 */
export const SECRET_LEAK_RULES: readonly SecretLeakRule[] = [
	{
		id: "aws_access_key_id",
		label: "AWS Access Key ID",
		severity: "critical",
		// 20-char key beginning with a known AWS prefix. ASIA = STS, AKIA = IAM, etc.
		pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|AIPA|ASCA)[0-9A-Z]{16}\b/g,
	},
	{
		id: "aws_secret_access_key",
		label: "AWS Secret Access Key",
		severity: "critical",
		// 40-char base64 secret, only flagged when preceded by an assignment context
		// — the bare 40-char string has too many false positives on session text.
		pattern: /(?:aws_secret_access_key|awsSecretAccessKey|SecretAccessKey|secret_access_key)["'\s:=]{1,4}([A-Za-z0-9/+]{40})\b/g,
	},
	{
		id: "github_pat_classic",
		label: "GitHub Personal Access Token (classic)",
		severity: "critical",
		pattern: /\bghp_[0-9A-Za-z]{36}\b/g,
	},
	{
		id: "github_pat_fine_grained",
		label: "GitHub Fine-grained Personal Access Token",
		severity: "critical",
		pattern: /\bgithub_pat_[0-9A-Za-z_]{82}\b/g,
	},
	{
		id: "github_oauth_token",
		label: "GitHub OAuth Token",
		severity: "high",
		pattern: /\bgho_[0-9A-Za-z]{36}\b/g,
	},
	{
		id: "github_app_token",
		label: "GitHub App Token",
		severity: "high",
		pattern: /\bghs_[0-9A-Za-z]{36}\b/g,
	},
	{
		id: "github_user_token",
		label: "GitHub User-to-Server Token",
		severity: "high",
		pattern: /\bghu_[0-9A-Za-z]{36}\b/g,
	},
	{
		id: "github_refresh_token",
		label: "GitHub Refresh Token",
		severity: "high",
		pattern: /\bghr_[0-9A-Za-z]{76}\b/g,
	},
	{
		id: "google_api_key",
		label: "Google API Key",
		severity: "high",
		pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
	},
	{
		id: "slack_token",
		label: "Slack Token",
		severity: "critical",
		pattern: /\bxox[abprs]-[0-9A-Za-z-]{10,}[0-9A-Za-z]\b/g,
	},
	{
		id: "slack_webhook",
		label: "Slack Webhook URL",
		severity: "critical",
		pattern: /\bhttps:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{16,}\b/g,
	},
	{
		id: "stripe_live_secret_key",
		label: "Stripe Live Secret Key",
		severity: "critical",
		pattern: /\bsk_live_[0-9A-Za-z]{24,}\b/g,
	},
	{
		id: "stripe_restricted_key",
		label: "Stripe Restricted Key",
		severity: "critical",
		pattern: /\brk_live_[0-9A-Za-z]{24,}\b/g,
	},
	{
		id: "gitlab_pat",
		label: "GitLab Personal Access Token",
		severity: "critical",
		pattern: /\bglpat-[0-9A-Za-z_-]{20}\b/g,
	},
	{
		id: "anthropic_api_key",
		label: "Anthropic API Key",
		severity: "critical",
		pattern: /\bsk-ant-[0-9A-Za-z_-]{93,}\b/g,
	},
	{
		id: "openai_api_key",
		label: "OpenAI API Key",
		severity: "critical",
		// `sk-` followed by 48 base62 chars. `sk_live_` (Stripe) has an underscore
		// and so does not match. `sk-ant-` (Anthropic) has hyphens that break the
		// 48-char run, and is listed first so matchAll finds it before this runs.
		pattern: /\bsk-[0-9A-Za-z]{48}\b/g,
	},
	{
		id: "openai_project_key",
		label: "OpenAI Project API Key",
		severity: "critical",
		pattern: /\bsk-proj-[0-9A-Za-z_-]{40,}\b/g,
	},
	{
		id: "private_key_block",
		label: "Private Key (PEM)",
		severity: "critical",
		// The PEM header line is enough to flag — the body follows in the same field.
		// The optional prefix covers RSA/EC/DSA/OPENSSH/PGP/ENCRYPTED; the bare
		// `-----BEGIN PRIVATE KEY-----` form is matched by the empty alternative.
		pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
	},
	{
		id: "jwt",
		label: "Signed JWT",
		severity: "high",
		// Three base64url segments separated by dots, each at least 8 chars.
		pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
	},
];

// ──────────────────────────── findings ────────────────────────────

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
	 * content. For capture-group rules (aws_secret_access_key) this is the
	 * captured group length.
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
 * The value a rule match contributes. For rules with a capture group (e.g.
 * aws_secret_access_key) the secret is group 1; otherwise it is the whole match.
 */
function matchedSecret(match: RegExpMatchArray): string {
	return match[1] ?? match[0];
}

/**
 * Scan a single text field for all rule matches, returning raw findings (before
 * allowlisting/severity filtering). A fresh regex is cloned per field so the
 * shared catalogue's `lastIndex` never leaks between calls.
 */
function scanField(
	text: string,
	field: LeakField,
	messageId: string,
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
 * Detect secret leaks across a session's messages. Pure and deterministic.
 *
 * @param messages the session's message rows, in order
 * @param config the resolved analyzer config (defaults applied for missing keys)
 */
export function detectSecretLeaks(
	messages: readonly MessageRow[],
	config: SecretLeakConfig = DEFAULT_SECRET_LEAK_CONFIG,
): SecretLeakScanResult {
	const disabled = new Set(config.disabledRules);
	const allowFp = new Set(config.allowFingerprints);
	const allowPatterns = config.allowPatterns.map((src) => new RegExp(src, "u"));
	const maxPerField = config.maxMatchesPerField;

	// Filter to enabled, min-severity rules. Keep catalogue order for determinism.
	const activeRules = SECRET_LEAK_RULES.filter(
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

			const hits = scanField(raw, label, m.id, activeRules);

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
 * Convenience: scan a single string and return the rule ids that matched. Used
 * by unit tests; not called on the hot path.
 */
export function matchedRuleIds(text: string): string[] {
	const ids = new Set<string>();
	for (const rule of SECRET_LEAK_RULES) {
		const re = new RegExp(rule.pattern.source, rule.pattern.flags);
		if (re.test(text)) ids.add(rule.id);
		// Reset lastIndex in case the shared flag-bearing regex was stateful.
		re.lastIndex = 0;
	}
	return [...ids].sort();
}