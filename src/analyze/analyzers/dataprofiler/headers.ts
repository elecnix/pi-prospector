/**
 * Header-label inference: the DataProfiler half that judges a column by its
 * *name*, independent of any value.
 *
 * A hand-written catalogue of label groups maps header-cell text (case-
 * insensitive, substring-anchored by word boundaries) to a sensitivity group
 * and — where a deterministic shape validator exists — to the recognizer
 * entity types whose shapes would *support* the label. `name`, `dob`, and
 * `salary` have no deterministic recognizer (NER is deferred in the shared
 * recognizer stack), so their columns can only ever be `label-only` findings;
 * that is the honest ceiling of a no-model analyzer and the finding says so
 * through its verdict.
 *
 * Everything here is pure and deterministic: fixed group order, fixed pattern
 * order, no locale-dependent behaviour.
 */

import type { PiiEntityType } from "../presidio/recognizers.js";
import type { HeaderLabelGroups } from "./config.js";

/** The header-label groups a column can carry. */
export const HEADER_LABEL_GROUP_IDS = [
	"name",
	"email",
	"phone",
	"ssn",
	"address",
	"dob",
	"salary",
	"account",
] as const;
export type HeaderLabelGroupId = (typeof HEADER_LABEL_GROUP_IDS)[number];

export interface HeaderLabelRule {
	/** Group id — the config-facing identifier. */
	group: HeaderLabelGroupId;
	/** Human-readable label for findings. */
	label: string;
	/**
	 * Patterns tested against the trimmed header cell (case-insensitive).
	 * Must not carry the `g` flag; tested with `.test()`.
	 */
	patterns: RegExp[];
	/**
	 * Recognizer entity types whose shapes would support this label. Empty for
	 * groups with no deterministic recognizer (name, dob, salary).
	 */
	impliedEntities: readonly PiiEntityType[];
}

/**
 * The shipped label catalogue, in group order. Order is load-bearing: a
 * column's `labels` list and its primary label follow catalogue order.
 */
export const HEADER_LABEL_RULES: readonly HeaderLabelRule[] = [
	{
		group: "name",
		label: "Person name",
		patterns: [
			/\bfirst[ _-]?name\b/,
			/\blast[ _-]?name\b/,
			/\bfull[ _-]?name\b/,
			/\bcustomer[ _-]?name\b/,
			/\bsurname\b/,
			/\bgiven[ _-]?name\b/,
			/^name$/,
		],
		impliedEntities: [],
	},
	{
		group: "email",
		label: "Email address",
		patterns: [/\be[ _-]?mails?\b/, /\be[ _-]?mail[ _-]?addr/, /\bmail\b/],
		impliedEntities: ["EMAIL_ADDRESS"],
	},
	{
		group: "phone",
		label: "Phone number",
		patterns: [/\bphones?\b/, /\btels?\b/, /\btelephones?\b/, /\bmobiles?\b/, /\bcells?\b/, /\bcontact[ _-]?numbers?\b/],
		impliedEntities: ["PHONE_NUMBER"],
	},
	{
		group: "ssn",
		label: "National identifier (SSN and similar)",
		patterns: [/\bssn\b/, /\bsocial[ _-]?security\b/, /\bnational[ _-]?id(?:entifier)?\b/, /\btax[ _-]?id(?:entifier)?\b/, /\bnino\b/],
		impliedEntities: ["US_SSN"],
	},
	{
		group: "address",
		label: "Postal address",
		patterns: [/\baddresses?\b/, /\bstreets?\b/, /\bzip[ _-]?codes?\b/, /\bpost(?:al)?[ _-]?codes?\b/, /\bcity\b/, /\bstate\b/, /\bcountr(?:y|ies)\b/],
		impliedEntities: ["POSTAL_CODE"],
	},
	{
		group: "dob",
		label: "Date of birth",
		patterns: [/\bdob\b/, /\bdate[ _-]?of[ _-]?birth\b/, /\bbirth[ _-]?(?:date|day)\b/, /\bborn\b/],
		impliedEntities: [],
	},
	{
		group: "salary",
		label: "Salary / compensation",
		patterns: [/\bsalaries?\b/, /\bsalary\b/, /\bwages?\b/, /\bincomes?\b/, /\bcompensation\b/],
		impliedEntities: [],
	},
	{
		group: "account",
		label: "Financial account",
		patterns: [
			/\baccounts?\b/,
			/\baccount[ _-]?id/,
			/\baccount[ _-]?num/,
			/\bibans?\b/,
			/\bcards?\b/,
			/\brouting[ _-]?numbers?\b/,
			/\bcredit[ _-]?cards?\b/,
			/\bbank/,
		],
		impliedEntities: ["CREDIT_CARD", "IBAN_CODE"],
	},
];

/**
 * Infer the sensitive labels carried by one header cell.
 *
 * Pure and deterministic. Returns the fired rules in catalogue order. A cell
 * that fires no rule yields an empty array — the column is then judged by its
 * value distribution alone.
 *
 * Separator normalisation: `_` and `-` are word characters for regex
 * purposes, so `customer_email` would defeat every `\b`-anchored pattern.
 * The cell is lowercased and separator runs are folded to spaces first, so
 * `customer_email`, `Customer Email`, and `customer-email` all read the same.
 *
 * @param cell the header cell text (trimmed internally)
 * @param groups which label groups are enabled (from config)
 */
export function inferHeaderLabels(
	cell: string,
	groups: HeaderLabelGroups,
): HeaderLabelRule[] {
	const t = cell.trim().toLowerCase().replace(/[_-]+/g, " ");
	if (t.length === 0) return [];
	const fired: HeaderLabelRule[] = [];
	for (const rule of HEADER_LABEL_RULES) {
		if (!groups[rule.group]) continue;
		for (const pattern of rule.patterns) {
			if (pattern.test(t)) {
				fired.push(rule);
				break;
			}
		}
	}
	return fired;
}
