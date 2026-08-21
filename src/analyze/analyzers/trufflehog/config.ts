/**
 * Configuration for the TruffleHog-style detector analyzer.
 *
 * The detection half is deterministic — no LLM, no network — and emits one
 * `metric` node per session. The `verify` flag turns on the *verification*
 * half, which makes live network calls to credential-issuing providers (see
 * `verifiers.ts`).
 *
 * Everything here is part of the config fingerprint, so changing it produces a
 * new config identity and, on a run that includes the `config` reason, new
 * node versions (old nodes preserved as lineage). This matters especially for
 * `verify`: flipping it on is a **materially different analysis** (network
 * results are folded into the node), so enabling it deliberately marks prior
 * detection-only nodes `stale/config` rather than silently reusing them. A
 * plain fill never recomputes them; `--revise config` does, keeping the old
 * nodes as lineage.
 *
 * Allowlists are **fingerprint/shape-based by design**: a user never pastes a
 * real secret into config (config is content-addressed and stored in the
 * analysis graph — storing a secret there would be the very leak this
 * analyzer exists to catch). `allowFingerprints` uses the same short SHA-256
 * fingerprint the analyzer records for a match; `allowPatterns` matches by
 * shape regex against the matched value.
 */

import { Type, type Static } from "typebox";
import { TRUFFLEHOG_RULE_IDS } from "./rules.js";
import { VERIFIER_IDS } from "./verifiers.js";

export const TruffleHogConfigSchema = Type.Object({
	/**
	 * Rule ids to skip entirely. Ids are this analyzer's kebab-case rule ids —
	 * see `TRUFFLEHOG_RULES` in rules.ts.
	 */
	disabledRules: Type.Array(Type.String()),
	/**
	 * **Live credential verification — off by default.** When `true`, each
	 * finding is probed against the provider that issued it (each verifier
	 * talks only to its own provider; the credential is sent nowhere else).
	 * This makes network calls and folds their results into the node, so it is
	 * opt-in; enabling it marks prior nodes `stale/config` (see the module
	 * docstring).
	 */
	verify: Type.Boolean(),
	/**
	 * Verifier ids to use when `verify` is true. An **empty list means all**
	 * shipped verifiers are active; listing ids restricts verification to
	 * those. Ids — see `VERIFIER_IDS` in verifiers.ts:
	 * `github-token`, `openai-key`, `figma-token`.
	 */
	enabledVerifiers: Type.Array(Type.String()),
	/**
	 * Per-probe timeout in milliseconds for verification network calls. A probe
	 * that exceeds it resolves to `verified: "unknown"` (reason `timeout`) —
	 * it never fails the analysis.
	 */
	timeoutMs: Type.Integer({ minimum: 1 }),
	/**
	 * Short SHA-256 fingerprints (16 hex chars) of matched values to ignore,
	 * e.g. a committed test fixture token. Never put the raw secret here —
	 * config is persisted in the graph. The fingerprint is what the analyzer
	 * stores for a match, so it can be copied from an existing finding.
	 */
	allowFingerprints: Type.Array(Type.String()),
	/**
	 * Regex source strings tested against a matched value; a match is ignored.
	 * Use this for shape-based allowlisting (e.g. `"^figd_example"`), never for
	 * a literal secret.
	 */
	allowPatterns: Type.Array(Type.String()),
	/**
	 * Maximum matches recorded per message field (after allowlisting). Bounds
	 * node size for a pathological field; extra survivors are counted in
	 * `truncated_matches` but not listed.
	 */
	maxMatchesPerField: Type.Integer({ minimum: 1 }),
	/**
	 * Lowest severity to report. `critical` reports only critical; `high`
	 * reports critical + high; `medium` reports all (the default).
	 */
	minSeverity: Type.Union([
		Type.Literal("medium"),
		Type.Literal("high"),
		Type.Literal("critical"),
	]),
});
export type TruffleHogConfig = Static<typeof TruffleHogConfigSchema>;

export const DEFAULT_TRUFFLEHOG_CONFIG: TruffleHogConfig = {
	disabledRules: [],
	verify: false,
	enabledVerifiers: [],
	timeoutMs: 10_000,
	allowFingerprints: [],
	allowPatterns: [],
	maxMatchesPerField: 50,
	minSeverity: "medium",
};

/**
 * Validate config-facing ids against the catalogues so a typo fails loudly
 * (errors thrown with messages, no silent catches).
 */
export function assertKnownRuleAndVerifierIds(config: TruffleHogConfig): void {
	const rules = new Set<string>(TRUFFLEHOG_RULE_IDS);
	for (const id of config.disabledRules) {
		if (!rules.has(id)) {
			throw new Error(
				`trufflehog: unknown rule id '${id}' in disabledRules (known: ${[...rules].join(", ")})`,
			);
		}
	}
	const verifiers = new Set<string>(VERIFIER_IDS);
	for (const id of config.enabledVerifiers) {
		if (!verifiers.has(id)) {
			throw new Error(
				`trufflehog: unknown verifier id '${id}' in enabledVerifiers (known: ${[...verifiers].join(", ")})`,
			);
		}
	}
}
