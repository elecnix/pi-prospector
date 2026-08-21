/**
 * Configuration for the Presidio-method PII detector analyzer.
 *
 * Everything here is part of the config fingerprint, so changing it produces a
 * new config identity and, on a run that includes the `config` reason, new
 * node versions (old nodes preserved as lineage).
 *
 * **No raw PII in config.** Config is content-addressed and persisted in the
 * analysis graph — storing a person's name, card number, or any other PII
 * there would be the very leak this analyzer exists to catch. Both lists are
 * therefore fingerprint-based:
 *
 * - `allowFingerprints` — values to ignore (e.g. the standard test card in a
 *   committed fixture). Uses the same short SHA-256 fingerprint the analyzer
 *   records for a match, so it can be copied from an existing finding.
 * - `denyFingerprints` — exact-match entities to **always flag** (e.g. a known
 *   identifier). A denied value bypasses the allowlist and the score floor;
 *   exact match is by fingerprint equality of the full matched value.
 * - `allowPatterns` — shape regexes tested against a matched value, for
 *   shape-based allowlisting (e.g. `"^4111"`), never for a literal value.
 *
 * An NER recognizer (person names, addresses) added later through the LLM seam
 * joins via its recognizer/entity-type id in `entityTypes` — no schema change.
 */

import { Type, type Static } from "typebox";
import { PII_ENTITY_TYPES } from "./recognizers.js";

export const PresidioConfigSchema = Type.Object({
	/**
	 * Entity types to detect, as Presidio-style labels — see
	 * `PII_ENTITY_TYPES` in recognizers.ts. An **empty list means all** shipped
	 * recognizers are active; listing types restricts detection to those.
	 * Validated against the registry so a typo fails loudly.
	 */
	entityTypes: Type.Array(Type.String()),
	/**
	 * **Checksum validators on/off (default on).** Where a format has a
	 * checksum — credit card Luhn, IBAN mod-97 — a failing value is *not a
	 * finding* while this is on (Presidio's key precision trick). Turning it
	 * off reports unvalidated candidates at each recognizer's base score
	 * instead, which trades precision for recall; it is a config change and
	 * marks prior nodes `stale/config`.
	 */
	validatorsEnabled: Type.Boolean(),
	/**
	 * Minimum confidence (0..1) to report. Findings below the floor are
	 * counted in `below_score_matches` but not listed — except deny-listed
	 * values, which always surface.
	 */
	minScore: Type.Number({ minimum: 0, maximum: 1 }),
	/**
	 * Short SHA-256 fingerprints (16 hex chars) of matched values to ignore —
	 * never the raw value. The fingerprint is what the analyzer stores for a
	 * match, so it can be copied from an existing finding.
	 */
	allowFingerprints: Type.Array(Type.String()),
	/**
	 * Regex source strings tested against a matched value; a match is ignored.
	 * Shape-based allowlisting only — never a literal PII value.
	 */
	allowPatterns: Type.Array(Type.String()),
	/**
	 * Short SHA-256 fingerprints of values to **always flag** (exact match by
	 * fingerprint). A denied value bypasses the allowlist and the score floor.
	 * Store fingerprints here, never raw PII.
	 */
	denyFingerprints: Type.Array(Type.String()),
	/**
	 * Maximum matches recorded per message field (after allow/deny filtering).
	 * Bounds node size for a pathological field; extra survivors are counted
	 * in `truncated_matches` but not listed.
	 */
	maxMatchesPerField: Type.Integer({ minimum: 1 }),
});
export type PresidioConfig = Static<typeof PresidioConfigSchema>;

export const DEFAULT_PRESIDIO_CONFIG: PresidioConfig = {
	entityTypes: [],
	validatorsEnabled: true,
	// 0.3 keeps the deliberate noise floor out of default output: private-IP
	// (0.1) and structurally-invalid SSN (0.2) candidates are counted but not
	// listed; every validated recognizer scores ≥ 0.3.
	minScore: 0.3,
	allowFingerprints: [],
	allowPatterns: [],
	denyFingerprints: [],
	maxMatchesPerField: 50,
};

/**
 * Validate config-facing ids against the registry so a typo fails loudly
 * (errors thrown with messages, no silent catches). The TypeBox schema
 * already constrains `entityTypes` to known labels; this re-checks
 * defensively for programmatically-built config and is the single place a
 * future NER entity type would be validated too.
 */
export function assertKnownEntityTypes(config: PresidioConfig): void {
	const known = new Set<string>(PII_ENTITY_TYPES);
	for (const t of config.entityTypes) {
		if (!known.has(t)) {
			throw new Error(
				`presidio: unknown entity type '${t}' in entityTypes (known: ${[...known].join(", ")})`,
			);
		}
	}
}
