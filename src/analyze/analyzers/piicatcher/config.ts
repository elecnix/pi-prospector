/**
 * Configuration for the PIICatcher-method column-semantics PII detector.
 *
 * Everything here is part of the config fingerprint, so changing it produces a
 * new config identity and, on a run that includes the `config` reason, new
 * node versions (old nodes preserved as lineage).
 *
 * **No raw PII in config.** Config is content-addressed and persisted in the
 * analysis graph — storing a person's name, card number, or any other PII
 * there would be the very leak this analyzer exists to catch. All lists are
 * therefore fingerprint- or shape-based:
 *
 * - `allowFingerprints` — values to ignore (e.g. the standard test card in a
 *   committed fixture). Uses the same short SHA-256 fingerprint the analyzer
 *   records for a match, so it can be copied from an existing finding.
 * - `denyFingerprints` — exact-match values to **always flag**. A denied value
 *   bypasses the allowlist and the score floor; matching is by fingerprint of
 *   the full matched value.
 * - `allowPatterns` — shape regexes tested against a matched value, for
 *   shape-based allowlisting (e.g. `"^4111"`), never for a literal value.
 *
 * Method reference: Tokern PIICatcher — tabular fragment detection, per-column
 * value sampling, and statistical column classification. Licence verified
 * against the upstream repository: **Apache-2.0** (the referring issue said
 * MIT; the `tokern/piicatcher` LICENSE file is Apache-2.0). Only the *method*
 * is implemented here; no upstream code was vendored or ported. Reference
 * version studied: `tokern/piicatcher` v0.21.2 (latest release).
 */

import { Type, type Static } from "typebox";

/** Tabular format toggles: which fragment kinds detection looks for. */
export const FormatTogglesSchema = Type.Object({
	/** Character-separated blocks (delimiter sniffed among `,` `;` tab). */
	csv: Type.Boolean(),
	/** JSON arrays of homogeneous object records. */
	json: Type.Boolean(),
	/** SQL result tables: box-drawing, pipe/ASCII-bordered, aligned columns. */
	sql: Type.Boolean(),
});
export type FormatToggles = Static<typeof FormatTogglesSchema>;

export const PiicatcherConfigSchema = Type.Object({
	/** Which tabular fragment formats to detect. */
	formats: FormatTogglesSchema,
	/**
	 * Maximum values sampled per column (fixed order: top-down). Statistical
	 * classification judges only the sample, so this bounds work on wide
	 * fragments; PIICatcher's sampling behaviour with a deterministic order.
	 */
	sampleSizePerColumn: Type.Integer({ minimum: 1 }),
	/**
	 * Minimum fraction (0..1) of sampled values that must match sensitive
	 * shapes for the column to be reported. 0.5 means "most of the column";
	 * 1.0 means every sampled value.
	 */
	sensitivityThreshold: Type.Number({ minimum: 0, maximum: 1 }),
	/**
	 * Minimum recognizer confidence (0..1) for one sampled value to count as a
	 * match. Mirrors presidio's floor: private-IP (0.1) and structurally
	 * invalid SSN (0.2) candidates stay below the default 0.3.
	 */
	minScore: Type.Number({ minimum: 0, maximum: 1 }),
	/**
	 * Short SHA-256 fingerprints (as stored on findings) of values to ignore —
	 * never the raw value. An allowlisted value does not count toward a
	 * column's match ratio.
	 */
	allowFingerprints: Type.Array(Type.String()),
	/**
	 * Regex source strings tested against a matched value; a match is ignored.
	 * Shape-based allowlisting only — never a literal PII value.
	 */
	allowPatterns: Type.Array(Type.String()),
	/**
	 * Short SHA-256 fingerprints of values to **always flag** (exact match by
	 * fingerprint). A denied value counts as a match regardless of the score
	 * floor and bypasses the allowlist. Store fingerprints here, never raw PII.
	 */
	denyFingerprints: Type.Array(Type.String()),
	/**
	 * Maximum column findings recorded per message field (after filtering).
	 * Bounds node size for a pathological field; extra survivors are counted
	 * in `truncated_matches` but not listed.
	 */
	maxMatchesPerField: Type.Integer({ minimum: 1 }),
});
export type PiicatcherConfig = Static<typeof PiicatcherConfigSchema>;

export const DEFAULT_PIICATCHER_CONFIG: PiicatcherConfig = {
	formats: { csv: true, json: true, sql: true },
	// Ten values is enough for a stable ratio at the default threshold while
	// bounding work per column.
	sampleSizePerColumn: 10,
	// Half the column must match: 9/10 emails fires, 1/10 does not.
	sensitivityThreshold: 0.5,
	// Same rationale as presidio's default: keeps deliberate noise-floor
	// judgements (private IPs, invalid-shape SSNs) out of the match count.
	minScore: 0.3,
	allowFingerprints: [],
	allowPatterns: [],
	denyFingerprints: [],
	maxMatchesPerField: 50,
};
