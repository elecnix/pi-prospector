/**
 * Configuration for the secret-leak analyzer.
 *
 * The analyzer scans session transcripts for high-confidence secret patterns
 * (provider-anchored token formats, private-key headers, signed JWTs). It is
 * deterministic — no LLM — and emits one `metric` node per session.
 *
 * All thresholds and the allowlist are part of the config fingerprint, so
 * changing them produces a new config identity and, on a run that includes the
 * `config` reason, new node versions (old nodes preserved as lineage).
 *
 * The allowlist is **fingerprint-based by design**: a user never pastes a real
 * secret into config (config is content-addressed and stored in the analysis
 * graph — storing a secret there would be the very leak this analyzer exists to
 * catch). Instead the user allows a known-safe value by its short SHA-256
 * prefix, the same fingerprint the analyzer records for a detected match, so a
 * fixture token can be silenced without ever re-entering it.
 */

import { Type, type Static } from "typebox";

export const SecretLeakConfig = Type.Object({
	/**
	 * Rule ids to skip entirely. See `SECRET_LEAK_RULES` in detectors.ts for the
	 * catalogue of built-in rule ids.
	 */
	disabledRules: Type.Array(Type.String()),
	/**
	 * Short SHA-256 fingerprints (16 hex chars) of matched values to ignore,
	 * e.g. a committed test fixture token. Never put the raw secret here —
	 * config is persisted in the graph. The fingerprint is what the analyzer
	 * stores for a match, so it can be copied from an existing finding.
	 */
	allowFingerprints: Type.Array(Type.String()),
	/**
	 * Regex source strings tested against a matched value; a match is ignored.
	 * Use this for shape-based allowlisting (e.g. `"^AKIATEST"`), never for a
	 * literal secret.
	 */
	allowPatterns: Type.Array(Type.String()),
	/**
	 * Maximum matches recorded per message field. Bounds node size for a
	 * pathological field that matches a pattern thousands of times. Extra
	 * matches beyond this are counted in `truncated_matches` but not listed.
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
export type SecretLeakConfig = Static<typeof SecretLeakConfig>;

export const DEFAULT_SECRET_LEAK_CONFIG: SecretLeakConfig = {
	disabledRules: [],
	allowFingerprints: [],
	allowPatterns: [],
	maxMatchesPerField: 50,
	minSeverity: "medium",
};

/** Severity rank used to compare against `minSeverity`. */
export const SEVERITY_RANK: Record<SecretLeakConfig["minSeverity"], number> = {
	medium: 1,
	high: 2,
	critical: 3,
};

/** Rule severities used by the detector catalogue. */
export type LeakSeverity = "medium" | "high" | "critical";

/** Does `sev` meet the configured `minSeverity` floor? */
export function meetsMinSeverity(sev: LeakSeverity, minSeverity: SecretLeakConfig["minSeverity"]): boolean {
	const rank: Record<LeakSeverity, number> = { medium: 1, high: 2, critical: 3 };
	return rank[sev] >= SEVERITY_RANK[minSeverity];
}