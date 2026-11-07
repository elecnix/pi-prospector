import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_HARNESS } from "../../metrics/limits.js";
import { LIMIT_ALLOWLIST, LIMIT_CAPS, LIMIT_REDACTED, LIMIT_SCAN_FIELDS } from "../../metrics/security.js";

export const metrics: MetricDefinition[] = [
	{
		id: "piicatcher.column-finding",
		name: "Sensitive column findings",
		definition: "A column of a table fragment in a message whose sampled values match a sensitive entity shape in a share at or above the sensitivity threshold.",
		measurement: "rule-based",
		unit: "column findings per session",
		denominator: "none: the node stores the finding count, the fragments scanned and the columns classified",
		limitations: [
			"The unit is a column and not a value. One column of many matching values is one finding, so the count measures how many kinds of data a table held and not how many people it covers.",
			"The method samples up to a configured number of values per column, so a column that is sensitive in rows past the sample goes undetected.",
			"A column below the threshold is not reported. The node stores the count of such columns, and a change of the threshold moves the finding count with no change in the transcript.",
			"Fragments are found by shape. A table in another layout, a wrapped line or a truncated result goes unseen.",
			"The values match the shared recognizer stack, so the entity limits of presidio apply to what counts as a sensitive value.",
			LIMIT_REDACTED,
			LIMIT_SCAN_FIELDS,
			LIMIT_CAPS,
			LIMIT_ALLOWLIST,
			LIMIT_HARNESS,
		],
	},
	{
		id: "piicatcher.fragment-kind",
		name: "Table fragment kind",
		definition: "The layout of the table fragment a column finding came from.",
		measurement: "rule-based",
		unit: "findings per fragment kind",
		denominator: "column findings of the session",
		values: [
			{ value: "csv", meaning: "A block of delimited rows." },
			{ value: "json", meaning: "An array of JSON records." },
			{ value: "sql-table", meaning: "A result table printed by a SQL client." },
		],
		limitations: [
			"The kind describes how the text was laid out in the transcript, and not the format of any file behind it.",
		],
	},
];
