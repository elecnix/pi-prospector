/**
 * detect-secrets candidate generators: the ported plugin heuristics that
 * *produce* candidates, expressed in the shared `SecretLeakRule` shape so the
 * common secret-scanning engine matches, redacts, fingerprints, and caps them
 * identically to every other detector.
 *
 * Provenance: ported from Yelp detect-secrets **v1.5.0**, licensed
 * **BSD-3-Clause**. Source:
 * https://github.com/Yelp/detect-secrets/tree/v1.5.0/detect_secrets/plugins
 * Upstream plugin → ported generator:
 * - `KeywordDetector` → `keyword-assignment`, `keyword-reverse-comparison`
 * - `HexHighEntropyString` → `hex-high-entropy-string`
 * - `Base64HighEntropyString` → `base64-high-entropy-string`
 *
 * **Plugins deliberately skipped as covered elsewhere** (the shared engine
 * scans the same four fields, so re-porting them would only double the
 * findings the downstream synthesiser must collapse):
 * - `PrivateKeyDetector` and `JwtTokenDetector` — PEM and JWT are covered by
 *   the hand-written `secret-leak` catalogue (this is the explicit task
 *   contract: skip both, note it here).
 * - `AWSKeyDetector`, `GitHubTokenDetector`, `SlackDetector`,
 *   `StripeDetector`, `GitLabTokenDetector`, `SendGridDetector`,
 *   `TwilioDetector`, `DiscordDetector`, `NpmDetector`, `OpenAIDetector`,
 *   `BasicAuthDetector`, and the other provider-token plugins — covered by the
 *   `secret-leak` and gitleaks catalogues (AWS, GitHub, Google, Slack, Stripe,
 *   GitLab, Anthropic, OpenAI, PEM, JWT, npm, SendGrid, Twilio, Telegram, …).
 *
 * detect-secrets' precision comes from what happens **after** these
 * generators: the exclusion filters in `filters.ts`. The high-entropy
 * generators here match permissively (any quoted hex/base64 run) and rely on
 * the shannon-entropy gate — ported as the `low-entropy` filter — to reject
 * the bulk of prose noise, exactly as upstream applies the limit after
 * matching in `HighEntropyStringsPlugin.analyze_line`.
 *
 * Deviations from upstream, all documented:
 * - **Filetype-specific keyword regex sets are merged.** Upstream picks one
 *   regex family per file type (quotes-required for JS/Python, unquoted
 *   allowed for YAML/config). Session text has no file type, so the port uses
 *   one merged family that accepts quoted and unquoted values after `=`, `:`,
 *   `:=`, `=>`, and comparison operators.
 * - **`token` is added to the keyword denylist.** Upstream's list omits it;
 *   this port follows the task contract, which names it.
 * - **Quoted requirement kept for high-entropy plugins.** Upstream requires
 *   quotes to reduce noise; session prose quotes values far more often than
 *   it quotes git SHAs, so the same guard applies here.
 * - Upstream's capturing back-reference groups are made non-capturing so each
 *   rule has exactly one capturing group (the secret) — the shared engine
 *   reads group 1, and a catalogue invariant test enforces it.
 */

import type { SecretLeakRule } from "../secret-scanner.js";

/** Upstream provenance, asserted by tests so it cannot silently rot. */
export const DETECT_SECRETS_UPSTREAM = {
	/** Upstream project. */
	project: "detect-secrets",
	/** Upstream release the port was taken from. */
	version: "v1.5.0",
	/** Licence of the upstream project. */
	licence: "BSD-3-Clause",
	/** Upstream source tree the plugins and filters were ported from. */
	source: "https://github.com/Yelp/detect-secrets/tree/v1.5.0",
} as const;

// ──────────────────── shannon entropy (upstream plugin maths) ────────────────────

const BASE64_CHARSET =
	"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" +
	"+/" + // regular base64
	"-_" + // url-safe base64
	"="; // padding

const HEX_CHARSET = "0123456789abcdefABCDEF";

/**
 * Shannon entropy over a charset, ported from
 * `HighEntropyStringsPlugin.calculate_shannon_entropy` (which borrows from
 * http://blog.dkbza.org/2007/05/scanning-data-for-entropy-anomalies.html):
 * the sum of `-p·log₂(p)` over the charset's characters as they appear in
 * `data`.
 */
export function calculateShannonEntropy(data: string, charset: string = BASE64_CHARSET): number {
	if (data.length === 0) return 0;
	let entropy = 0;
	for (const ch of charset) {
		let count = 0;
		for (const c of data) if (c === ch) count++;
		const p = count / data.length;
		if (p > 0) entropy += -p * Math.log2(p);
	}
	return entropy;
}

/**
 * Hex-specific entropy, ported from `HexHighEntropyString`: when the input is
 * all digits the false positives greatly exceed true positives, so the
 * entropy is pulled down by `1.2 / log₂(len)` — enough to keep short
 * all-digit runs below the 3.0 limit while letting longer ones approach it.
 */
export function calculateHexShannonEntropy(data: string): number {
	const entropy = calculateShannonEntropy(data, HEX_CHARSET);
	if (data.length <= 1) return entropy;
	if (/^[0-9]+$/.test(data)) {
		return entropy - 1.2 / Math.log2(data.length);
	}
	return entropy;
}

// ──────────────────── keyword denylist (upstream KeywordDetector) ────────────────────

/**
 * Upstream's `DENYLIST` (all lowercase, `x_?y` = optional separator), plus
 * `token` forms per the documented deviation. `contrase[ñn]a` covers both the
 * accented and unaccented upstream entries.
 */
const KEYWORD_ALTERNATION =
	"(?:" +
	[
		"api[-_]?key",
		"auth[-_]?key",
		"service[-_]?key",
		"account[-_]?key",
		"db[-_]?key",
		"database[-_]?key",
		"priv[-_]?key",
		"private[-_]?key",
		"client[-_]?key",
		"access[-_]?token",
		"auth[-_]?token",
		"api[-_]?token",
		"token",
		"db[-_]?pass",
		"database[-_]?pass",
		"key[-_]?pass",
		"password",
		"passwd",
		"pwd",
		"secret",
		"contrase[ñn]a",
	].join("|") +
	")";

/**
 * The candidate value after an assignment: no whitespace, quotes, commas or
 * semicolons inside; at least four characters (upstream's SECRET regex allows
 * shorter, but its filters then reject one-character values outright —
 * requiring four here keeps the candidate stream small without losing any
 * survivor).
 */
const SECRET_VALUE = "[^\\s'\"`,;]{4,}";

/**
 * `keyword-assignment` — port of the upstream keyword regex family
 * (`FOLLOWED_BY_*`): a denylisted keyword (with word-char affixes, so
 * `my_password_secure` matches), optional closing brackets/quotes, then an
 * assignment or comparison operator, then the value, optionally quoted.
 * The secret is capture group 1.
 */
const KEYWORD_ASSIGNMENT = new RegExp(
	`${KEYWORD_ALTERNATION}\\w*["'\\])]{0,2}\\s*(?::=|=>|[=!]{1,3}|:)\\s*["'\`]?(${SECRET_VALUE})`,
	"gi",
);

/**
 * `keyword-reverse-comparison` — port of upstream's
 * `PRECEDED_BY_EQUAL_COMPARISON_SIGNS_QUOTES_REQUIRED_REGEX`: `"value" == my_password`.
 * The secret is capture group 1.
 */
const KEYWORD_REVERSE_COMPARISON = new RegExp(
	`["'](${SECRET_VALUE})["']\\s*[=!]{2,3}\\s*\\w*${KEYWORD_ALTERNATION}`,
	"gi",
);

/**
 * `hex-high-entropy-string` — port of `HexHighEntropyString`: quoted runs of
 * hex digits; the plugin's shannon-entropy limit (default 3.0) is applied by
 * the `low-entropy` filter, not the regex, exactly as upstream applies the
 * limit after matching.
 */
const HEX_HIGH_ENTROPY = /["']([0-9a-fA-F]{16,})["']/g;

/**
 * `base64-high-entropy-string` — port of `Base64HighEntropyString`: quoted
 * runs over the base64 alphabet (including url-safe `-`/`_` and `=` padding);
 * entropy limit (default 4.5) applied by the `low-entropy` filter.
 */
const BASE64_HIGH_ENTROPY = new RegExp(`["']([A-Za-z0-9+/\\-_]{16,}={0,2})["']`, "g");

// ──────────────────── generator catalogue ────────────────────

/** The detect-secrets plugins this analyzer ports, as config-facing ids. */
export const DETECT_SECRETS_PLUGINS = [
	"keyword-context",
	"hex-high-entropy",
	"base64-high-entropy",
] as const;

export type DetectSecretsPluginId = (typeof DETECT_SECRETS_PLUGINS)[number];

/** Which ported rules belong to which upstream plugin (for enable/disable). */
export const PLUGIN_RULE_IDS: Record<DetectSecretsPluginId, readonly string[]> = {
	"keyword-context": ["keyword-assignment", "keyword-reverse-comparison"],
	"hex-high-entropy": ["hex-high-entropy-string"],
	"base64-high-entropy": ["base64-high-entropy-string"],
};

/** Upstream default entropy limits, per plugin. */
export const DEFAULT_ENTROPY_LIMITS: Record<"hex-high-entropy" | "base64-high-entropy", number> = {
	"hex-high-entropy": 3.0,
	"base64-high-entropy": 4.5,
};

/**
 * The ported generator catalogue. Keyword rules are **active** (confirming
 * context required — the assignment itself); high-entropy rules are passive
 * (structure alone, gated by entropy + filters downstream).
 */
export const DETECT_SECRETS_GENERATORS: readonly SecretLeakRule[] = [
	{
		id: "keyword-assignment",
		label: "Secret Keyword (assignment context)",
		severity: "high",
		confidence: "active",
		pattern: KEYWORD_ASSIGNMENT,
	},
	{
		id: "keyword-reverse-comparison",
		label: "Secret Keyword (reverse comparison)",
		severity: "high",
		confidence: "active",
		pattern: KEYWORD_REVERSE_COMPARISON,
	},
	{
		id: "hex-high-entropy-string",
		label: "Hex High Entropy String",
		severity: "medium",
		confidence: "passive",
		pattern: HEX_HIGH_ENTROPY,
	},
	{
		id: "base64-high-entropy-string",
		label: "Base64 High Entropy String",
		severity: "medium",
		confidence: "passive",
		pattern: BASE64_HIGH_ENTROPY,
	},
];
