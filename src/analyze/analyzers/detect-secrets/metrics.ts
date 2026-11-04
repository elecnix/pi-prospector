import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_CAPS, LIMIT_DETECTION, LIMIT_REDACTED, LIMIT_SCAN_FIELDS, secretScannerMetrics } from "../../metrics/security.js";

const BASE = secretScannerMetrics("detect-secrets", "detect-secrets", [
	"The method ports detect-secrets: candidate generators (a keyword in context, hex and base64 strings above an entropy limit) followed by exclusion heuristics. Entropy limits and keyword lists are config, and a string below the limit or beside no keyword goes undetected.",
	"The exclusion heuristics drop placeholders, templated values, sequential strings, identifiers and documentation context. They can also drop a real credential that looks like one of those.",
]);

export const metrics: MetricDefinition[] = [
	...BASE,
	{
		id: "detect-secrets.plugin",
		name: "detect-secrets generator plugin",
		definition: "The candidate generator that produced a leak: the keyword-context rule, the hex high-entropy rule or the base64 high-entropy rule.",
		measurement: "rule-based",
		unit: "leaks per plugin",
		denominator: "leaks of the session",
		values: [
			{ value: "keyword-context", meaning: "A secret-like keyword sat next to a quoted or assigned value." },
			{ value: "hex-high-entropy", meaning: "A hexadecimal string whose Shannon entropy is above the limit." },
			{ value: "base64-high-entropy", meaning: "A base64 string whose Shannon entropy is above the limit." },
		],
		limitations: [
			"A rule id in the node maps to its plugin, and a plugin switched off in the config produces no candidates, so a zero for one plugin may mean it was disabled.",
			"Entropy is a property of the string and not of its use, so hashes, identifiers and encoded data match the entropy plugins.",
			LIMIT_DETECTION,
			LIMIT_REDACTED,
			LIMIT_SCAN_FIELDS,
			LIMIT_CAPS,
		],
	},
	{
		id: "detect-secrets.filtered-candidates",
		name: "detect-secrets filtered candidates",
		definition: "Candidates that an exclusion heuristic rejected, counted per heuristic.",
		measurement: "rule-based",
		unit: "candidates per filter",
		denominator: "none: it measures the filters and not the transcript",
		limitations: [
			"A candidate counts under the first filter that rejects it, so the per-filter split depends on the filter order.",
			"The count shows how much noise the generators produced. It is not a count of leaks avoided.",
		],
	},
];
