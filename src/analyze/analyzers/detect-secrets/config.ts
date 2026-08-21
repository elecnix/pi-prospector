/**
 * Configuration for the detect-secrets analyzer.
 *
 * The analyzer generates candidates with the ported detect-secrets plugin
 * generators (`generators.ts`) and then filters them with the ported
 * exclusion heuristics (`filters.ts`). It is deterministic — no LLM — and
 * emits one `metric` node per session.
 *
 * Everything here is part of the config fingerprint, so changing it produces a
 * new config identity and, on a run that includes the `config` reason, new
 * node versions (old nodes preserved as lineage).
 *
 * Allowlists are **fingerprint/shape-based by design**: a user never pastes a
 * real secret into config (config is content-addressed and stored in the
 * analysis graph — storing a secret there would be the very leak this
 * analyzer exists to catch). `allowFingerprints` uses the same short SHA-256
 * fingerprint the analyzer records for a match; `allowPatterns` matches by
 * shape regex against the matched value.
 */

import { Type, type Static } from "typebox";
import { DETECT_SECRETS_PLUGINS } from "./generators.js";
import { EXCLUSION_FILTER_IDS } from "./filters.js";

export const DetectSecretsConfig = Type.Object({
	/**
	 * Plugin ids to skip entirely. Ids are the ported upstream plugin names in
	 * kebab-case — see `DETECT_SECRETS_PLUGINS` in generators.ts:
	 * `keyword-context`, `hex-high-entropy`, `base64-high-entropy`.
	 */
	disabledPlugins: Type.Array(Type.String()),
	/**
	 * Exclusion-filter ids to skip. Ids are the kebab-case filter ids — see
	 * `EXCLUSION_FILTERS` in filters.ts (e.g. `placeholder-value`,
	 * `sequential-string`, `code-sample-context`). Disabling a filter lets
	 * candidates through that the heuristic would have rejected.
	 */
	disabledFilters: Type.Array(Type.String()),
	/**
	 * Shannon-entropy threshold override for the high-entropy plugins. When
	 * absent (the default), each plugin keeps its upstream limit — hex 3.0,
	 * base64 4.5. When set, it overrides **both** limits (the upstream range
	 * check is 0–8).
	 */
	entropyThreshold: Type.Optional(Type.Number({ minimum: 0, maximum: 8 })),
	/**
	 * Short SHA-256 fingerprints (16 hex chars) of matched values to ignore,
	 * e.g. a committed test fixture token. Never put the raw secret here —
	 * config is persisted in the graph. The fingerprint is what the analyzer
	 * stores for a match, so it can be copied from an existing finding.
	 */
	allowFingerprints: Type.Array(Type.String()),
	/**
	 * Regex source strings tested against a matched value; a match is ignored.
	 * Use this for shape-based allowlisting (e.g. `"^sk-example-"`), never for
	 * a literal secret.
	 */
	allowPatterns: Type.Array(Type.String()),
	/**
	 * Maximum matches recorded per message field (after filtering). Bounds node
	 * size for a pathological field; extra survivors are counted in
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
export type DetectSecretsConfig = Static<typeof DetectSecretsConfig>;

export const DEFAULT_DETECT_SECRETS_CONFIG: DetectSecretsConfig = {
	disabledPlugins: [],
	disabledFilters: [],
	allowFingerprints: [],
	allowPatterns: [],
	maxMatchesPerField: 50,
	minSeverity: "medium",
};

/**
 * Validate config-facing ids against the catalogues so a typo fails loudly
 * (errors thrown with messages, no silent catches).
 */
export function assertKnownPluginAndFilterIds(config: DetectSecretsConfig): void {
	const plugins = new Set<string>(DETECT_SECRETS_PLUGINS);
	for (const id of config.disabledPlugins) {
		if (!plugins.has(id)) {
			throw new Error(
				`detect-secrets: unknown plugin id '${id}' in disabledPlugins (known: ${[...plugins].join(", ")})`,
			);
		}
	}
	const filters = new Set<string>(EXCLUSION_FILTER_IDS);
	for (const id of config.disabledFilters) {
		if (!filters.has(id)) {
			throw new Error(
				`detect-secrets: unknown filter id '${id}' in disabledFilters (known: ${[...filters].join(", ")})`,
			);
		}
	}
}
