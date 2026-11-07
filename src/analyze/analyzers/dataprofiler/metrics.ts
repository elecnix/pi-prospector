import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_CALL_ID, LIMIT_HARNESS } from "../../metrics/limits.js";
import { LIMIT_ALLOWLIST, LIMIT_CAPS, LIMIT_REDACTED } from "../../metrics/security.js";

export const metrics: MetricDefinition[] = [
	{
		id: "dataprofiler.file-finding",
		name: "Sensitive file findings",
		definition: "A tabular file that a tool call read or wrote, whose captured content parses into a table with at least one sensitive column.",
		measurement: "rule-based",
		unit: "file findings per session",
		denominator: "none: the node stores the finding count, the files touched and the files profiled",
		limitations: [
			"A file is profiled only when a tool call names its path and the paired tool result captured its content without ambiguity. A file the agent opened some other way, or whose result was truncated or carried several results, counts as touched without content and is never profiled.",
			"The node stores how many touches had no usable content and how many binary tabular files it skipped on purpose, so the files profiled can be far fewer than the files touched.",
			"Pairing a tool call with its result needs the call id. Versions before the call-id pairing fix could not pair the calls of sessions indexed before ids were stored, so those sessions have no profiled files.",
			"A path is kept verbatim from the tool-call arguments, so a path can reveal a name or a project. Treat the node as sensitive.",
			"The count is per file touch. A file read many times counts at each touch within the cap.",
			LIMIT_CALL_ID,
			LIMIT_REDACTED,
			LIMIT_CAPS,
			LIMIT_ALLOWLIST,
			LIMIT_HARNESS,
		],
	},
	{
		id: "dataprofiler.file-format",
		name: "Profiled file format",
		definition: "The tabular format that the extension of a file implies.",
		measurement: "rule-based",
		unit: "findings per format",
		denominator: "file findings of the session",
		values: [
			{ value: "csv", meaning: "A comma-delimited file." },
			{ value: "tsv", meaning: "A tab-delimited file." },
			{ value: "json", meaning: "A JSON array of records." },
		],
		limitations: [
			"The format comes from the file extension. A file with a misleading extension fails to parse and is not profiled.",
		],
	},
	{
		id: "dataprofiler.column-verdict",
		name: "Sensitive column verdict",
		definition: "How a column earned its place among a file's sensitive columns: its header, its values, or both.",
		measurement: "rule-based",
		unit: "sensitive columns per verdict",
		denominator: "sensitive columns of the session",
		values: [
			{ value: "confirmed", meaning: "The header label and the sampled values agree, and the column carries high severity." },
			{ value: "label-only", meaning: "The header names a sensitive field but the sampled values did not match. The column carries low severity." },
			{ value: "values-only", meaning: "The values match a sensitive shape under a header with no sensitive label. The column carries medium severity." },
		],
		limitations: [
			"The score combines the share of matching values with a header score by a configured weight, so a change of weight or threshold moves the verdicts.",
			"A label-only verdict is the weakest evidence: a header such as a name or an email can head a column of placeholders.",
		],
	},
];
