/**
 * TruffleHog-style detector rule catalogue — **original patterns, written for
 * this repository**.
 *
 * Licence decision (issue #170): TruffleHog itself is AGPL-3.0. Porting its
 * detection catalogue — code or rule text — is not licence-compatible the way
 * the Apache-2.0 (gitleaks) and MIT/Apache (Nosey Parker) catalogues are, so
 * **no upstream material was copied**. What this analyzer takes from
 * TruffleHog is its *verification concept* (see `verifiers.ts`); the detection
 * half below is a thin rule file over the shared secret-scanning engine
 * (`../secret-scanner.ts`), holding only patterns that are:
 *
 * 1. **written from scratch for this repo** — no AGPL-3.0 source consulted; and
 * 2. **genuinely new coverage** — the bundled catalogues already carry the
 *    broad provider coverage (secret-leak's hand-written catalogue, gitleaks'
 *    ~90 rules, Nosey Parker's ~55 confidence-scored rules, detect-secrets'
 *    generators + exclusion filters). Re-porting any of that would only double
 *    the findings the downstream proposal synthesiser must collapse, so this
 *    file adds only prefix-anchored provider tokens no bundled catalogue
 *    matches yet. An honest near-empty list beats duplication.
 *
 * Every pattern is prefix-anchored (the provider's distinctive token prefix)
 * with a conservative minimum length — no bare entropy heuristics, matching
 * this repo's precision discipline. Rules keep the shared `SecretLeakRule`
 * shape; the secret is the whole match (no capture group), so fingerprints
 * cover exactly the credential.
 */

import type { SecretLeakRule } from "../secret-scanner.js";

/**
 * Provenance for the *concept* this analyzer implements. Asserted by tests so
 * the licence decision cannot silently rot: if anyone ever adds a ported
 * TruffleHog pattern here, `materialUsed` must change and the licence
 * conversation must happen first.
 */
export const TRUFFLEHOG_CONCEPT = {
	/** Upstream project whose *idea* (live credential verification) this implements. */
	concept: "trufflehog",
	conceptUrl: "https://github.com/trufflesecurity/trufflehog",
	/** Upstream licence — the reason nothing from it is vendored or ported. */
	upstreamLicence: "AGPL-3.0",
	/** How much upstream material this catalogue contains. */
	materialUsed: "none",
	note: "Only the verification concept is attributed to TruffleHog. Every pattern below is original to this repository; no AGPL-3.0 code or rule text was consulted or copied.",
} as const;

// ──────────────────────────── rule catalogue ────────────────────────────

/**
 * The self-written catalogue. All rules are passive (the provider prefix is
 * the structural anchor); severity reflects what a live credential of each
 * kind grants.
 */
export const TRUFFLEHOG_RULES: readonly SecretLeakRule[] = [
	{
		// Modern Figma personal access tokens carry the `figd_` prefix. Nosey
		// Parker's port covers only the legacy UUID-shaped key material with a
		// "figma" keyword (np.figma.1); the prefix form is uncovered.
		id: "figma-pat-figd",
		label: "Figma Personal Access Token (figd_)",
		severity: "high",
		pattern: /\bfigd_[A-Za-z0-9_-]{30,}\b/g,
	},
	{
		// xAI (Grok platform) API keys carry the `xai-` prefix. Not matched by
		// any bundled catalogue; `sk-`-shaped rules deliberately do not cover it.
		id: "xai-api-key",
		label: "xAI API Key",
		severity: "high",
		pattern: /\bxai-[A-Za-z0-9]{40,}\b/g,
	},
	{
		// Replicate API tokens carry the `r8_` prefix. Not matched by any
		// bundled catalogue.
		id: "replicate-api-token",
		label: "Replicate API Token",
		severity: "high",
		pattern: /\br8_[A-Za-z0-9]{35,}\b/g,
	},
	{
		// Supabase management-API access tokens carry the `sbp_` prefix and
		// grant org/project administration — hence critical, not high. (The
		// Supabase service-role *key* is a JWT and is already covered by the
		// shared `jwt` rule in the secret-leak catalogue.)
		id: "supabase-management-token",
		label: "Supabase Management API Token",
		severity: "critical",
		pattern: /\bsbp_[A-Za-z0-9_-]{40,}\b/g,
	},
];

/** Rule ids in the catalogue, for config validation. */
export const TRUFFLEHOG_RULE_IDS: readonly string[] = TRUFFLEHOG_RULES.map((r) => r.id);
