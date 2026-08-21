/**
 * Secret-leak detectors.
 *
 * Pure functions operating on a session's message stream. Each detector is a
 * catalogue entry: a rule id, a label, a severity, and an anchored regular
 * expression tuned for **high precision** — the patterns require a
 * provider-specific prefix or structure that ordinary prose does not contain, so
 * a flagged match is very likely a real credential.
 *
 * The scanning machinery (redaction, fingerprinting, allowlists, per-field
 * caps) lives in the shared `secret-scanner` engine so every detector analyzer
 * derives findings — and especially fingerprints — identically. That shared
 * fingerprint is what lets the future proposal synthesiser collapse the same
 * leak found by several detectors into one proposal.
 */

import type { MessageRow } from "../../types.js";
import {
	scanMessages,
	matchedRuleIdsFor,
	type LeakSeverity,
	type SecretLeakRule,
} from "../secret-scanner.js";
import {
	DEFAULT_SECRET_LEAK_CONFIG,
	type SecretLeakConfig,
} from "./config.js";

// Re-export the shared engine surface so existing consumers (and tests) keep
// importing the detector vocabulary from this module.
export {
	fingerprintOf,
	redact,
	meetsMinSeverity,
	SEVERITY_RANK,
	type LeakField,
	type LeakSeverity,
	type SecretLeakFinding,
	type SecretLeakRule,
	type SecretLeakScanResult,
} from "../secret-scanner.js";

// ──────────────────────────── rule catalogue ────────────────────────────

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

// ──────────────────────────── detection ────────────────────────────

/**
 * Detect secret leaks across a session's messages. Pure and deterministic.
 *
 * @param messages the session's message rows, in order
 * @param config the resolved analyzer config (defaults applied for missing keys)
 */
export function detectSecretLeaks(
	messages: readonly MessageRow[],
	config: SecretLeakConfig = DEFAULT_SECRET_LEAK_CONFIG,
): ReturnType<typeof scanMessages> {
	return scanMessages(messages, SECRET_LEAK_RULES, config);
}

/**
 * Convenience: scan a single string and return the rule ids that matched. Used
 * by unit tests; not called on the hot path.
 */
export function matchedRuleIds(text: string): string[] {
	return matchedRuleIdsFor(SECRET_LEAK_RULES, text);
}
