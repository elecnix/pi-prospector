/**
 * Configuration for the nosey-parker analyzer.
 *
 * The analyzer scans session transcripts with the ported Nosey Parker rule
 * catalogue (`rules.ts`). It is deterministic — no LLM — and emits one
 * `metric` node per session.
 *
 * All thresholds and the allowlist are part of the config fingerprint, so
 * changing them produces a new config identity and, on a run that includes the
 * `config` reason, new node versions (old nodes preserved as lineage).
 *
 * The allowlist is **fingerprint-based by design**: a user never pastes a real
 * secret into config (config is content-addressed and stored in the analysis
 * graph — storing a secret there would be the very leak this analyzer exists
 * to catch). Instead the user allows a known-safe value by its short SHA-256
 * fingerprint, the same fingerprint the analyzer records for a detected match,
 * or by a shape pattern. `disabledRules` entries use the ported kebab-case ids
 * (each carries its upstream `np.<service>.<n>` id in `rules.ts`).
 *
 * `minConfidence` is the Nosey Parker confidence floor: `passive` (the
 * default) reports every rule, including bare-structure matches; `active`
 * reports only rules whose match carries confirming context (an assignment,
 * a keyword, an auth header) — the higher-precision tier.
 */

import { Type, type Static } from "typebox";

export const NoseyParkerConfig = Type.Object({
	/**
	 * Rule ids to skip entirely. Ids are the ported kebab-case ids — see
	 * `NOSEY_PARKER_RULES` in rules.ts for the catalogue.
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
	 * Use this for shape-based allowlisting (e.g. `"^sl\\.0+"`), never for a
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
	/**
	 * Lowest rule confidence to report. `passive` (the default) reports every
	 * matching rule; `active` reports only matches with confirming context.
	 */
	minConfidence: Type.Union([Type.Literal("passive"), Type.Literal("active")]),
});
export type NoseyParkerConfig = Static<typeof NoseyParkerConfig>;

export const DEFAULT_NOSEY_PARKER_CONFIG: NoseyParkerConfig = {
	disabledRules: [],
	allowFingerprints: [],
	allowPatterns: [],
	maxMatchesPerField: 50,
	minSeverity: "medium",
	minConfidence: "passive",
};
