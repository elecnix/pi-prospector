/**
 * Configuration for the DataProfiler-method tabular file PII detector.
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
 * Method reference: Capital One DataProfiler — schema/statistics/entity
 * extraction over tabular files, labelling which columns carry sensitive
 * entities from header labels validated by value-distribution analysis.
 * Licence verified against the upstream repository: **Apache-2.0**. Only the
 * *method* is implemented here; no upstream code was vendored or ported (the
 * original is Python). Reference version studied: `capitalone/DataProfiler`
 * v0.13.4 (latest release at time of writing).
 */

import { Type, type Static } from "typebox";

/** Tabular file-format toggles: which file extensions are extracted. */
export const FormatTogglesSchema = Type.Object({
	/** `.csv` files. */
	csv: Type.Boolean(),
	/** `.tsv` / `.tab` files. */
	tsv: Type.Boolean(),
	/** `.json` / `.jsonl` files (arrays of records, or NDJSON objects). */
	json: Type.Boolean(),
});
export type FormatToggles = Static<typeof FormatTogglesSchema>;

/** Which header-label groups participate in label inference. */
export const HeaderLabelGroupsSchema = Type.Object({
	/** Person names: `name`, `first_name`, `surname`, `customer_name`, … */
	name: Type.Boolean(),
	/** `email`, `e_mail`, `customer_email`, `email_address`, … */
	email: Type.Boolean(),
	/** `phone`, `tel`, `mobile`, `contact_number`, … */
	phone: Type.Boolean(),
	/** `ssn`, `social_security`, `national_id`, `tax_id`, … */
	ssn: Type.Boolean(),
	/** `address`, `street`, `city`, `zip`, `postal`, … */
	address: Type.Boolean(),
	/** `dob`, `date_of_birth`, `birthday`, … */
	dob: Type.Boolean(),
	/** `salary`, `wage`, `income`, `compensation`, … */
	salary: Type.Boolean(),
	/** `account`, `iban`, `card`, `routing_number`, … */
	account: Type.Boolean(),
});
export type HeaderLabelGroups = Static<typeof HeaderLabelGroupsSchema>;

export const DataprofilerConfigSchema = Type.Object({
	/** Which tabular file formats to extract and profile. */
	formats: FormatTogglesSchema,
	/** Header-label sensitivity inference (and its per-group toggles). */
	headerLabels: Type.Object({
		/** Master switch: when false, columns are judged by value distribution alone. */
		enabled: Type.Boolean(),
		/** Which label groups fire on header text. */
		groups: HeaderLabelGroupsSchema,
	}),
	/**
	 * Weight (0..1) of the value-distribution score in the combined per-column
	 * sensitivity score; the label score gets the complement. 0.6 means
	 * `score = 0.6·valueScore + 0.4·labelScore`.
	 */
	valueScoreWeight: Type.Number({ minimum: 0, maximum: 1 }),
	/**
	 * Minimum fraction (0..1) of sampled values that must match the column's
	 * implied sensitive shapes for the value distribution to *support* (or, for
	 * an unlabelled column, *establish*) sensitivity.
	 */
	valueThreshold: Type.Number({ minimum: 0, maximum: 1 }),
	/**
	 * Maximum values sampled per column (fixed order: top-down through the
	 * file's data rows). Empty cells count in the denominator — a sparse column
	 * with one email among blanks is not "an email column".
	 */
	sampleSize: Type.Integer({ minimum: 1 }),
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
	 * Maximum file findings recorded per message (after filtering). Bounds node
	 * size for a message that touched many tabular files; extra survivors are
	 * counted in `truncated_matches` but not listed.
	 */
	maxMatchesPerField: Type.Integer({ minimum: 1 }),
});
export type DataprofilerConfig = Static<typeof DataprofilerConfigSchema>;

export const DEFAULT_DATAPROFILER_CONFIG: DataprofilerConfig = {
	formats: { csv: true, tsv: true, json: true },
	headerLabels: {
		enabled: true,
		groups: {
			name: true,
			email: true,
			phone: true,
			ssn: true,
			address: true,
			dob: true,
			salary: true,
			account: true,
		},
	},
	// Value evidence dominates, but a bare label still contributes 40% — enough
	// to keep a downgraded label-only column visible in its finding's score.
	valueScoreWeight: 0.6,
	// Half the sampled column must match the implied shape for the distribution
	// to support a label (or to flag an unlabelled column).
	valueThreshold: 0.5,
	// Ten values is enough for a stable ratio at the default threshold while
	// bounding work per column.
	sampleSize: 10,
	// Same rationale as presidio's default: keeps deliberate noise-floor
	// judgements (private IPs, invalid-shape SSNs) out of the match count.
	minScore: 0.3,
	allowFingerprints: [],
	allowPatterns: [],
	denyFingerprints: [],
	maxMatchesPerField: 50,
};
