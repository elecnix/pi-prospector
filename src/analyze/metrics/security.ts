/**
 * Definitions the security scanners share.
 *
 * Five scanners (secret-leak, gitleaks, nosey-parker, detect-secrets,
 * trufflehog) run one engine and store the same finding shape, and three
 * (presidio, piicatcher, dataprofiler) store personal-data findings. Their limits
 * match, so they are written once here and each analyzer's `metrics.ts` lists
 * the ones that apply plus its own.
 */

import type { MetricDefinition } from "./types.js";
import { LIMIT_HARNESS } from "./limits.js";

export const LIMIT_REDACTED =
	"A node never stores the matched value. It keeps a redacted preview (the first and last few characters), a short fingerprint of the value, the length of the match and where it appeared, so a reader can recognise a finding without the content.";

export const LIMIT_SCAN_FIELDS =
	"The scan covers four fields of each message: its text, its reasoning, its tool calls and its tool results. A value in a file the agent never printed or passed to a tool is out of reach.";

export const LIMIT_DETECTION =
	"A scanner reports what its method matches. It can't tell a live credential or a real person's data from a fake one, an example or a test fixture, so a finding is a lead to check and not proof of a leak.";

export const LIMIT_CAPS =
	"The node stores at most the configured number of findings per field. The count of findings dropped by the cap, and those dropped by the allowlist, are stored beside it, so the finding count is a lower bound where a cap applied.";

export const LIMIT_ALLOWLIST =
	"An allowlist (by fingerprint or pattern) in the config removes matches before they count, so a change of allowlist is a config change that moves the count with no change in the transcript.";

export const LIMIT_SCAN_LANGUAGE =
	"Patterns match the formats of the providers and conventions they list. A credential in an unlisted format, or a value that an agent encoded or split across messages, goes undetected.";

/** Closed list shared by the five secret scanners. */
export const SEVERITY_VALUES = [
	{ value: "medium", meaning: "A credential of limited reach, or one that is common in documentation." },
	{ value: "high", meaning: "A credential that grants access to a service or account." },
	{ value: "critical", meaning: "A credential or key whose exposure is severe, such as a private key." },
];

export const CONFIDENCE_VALUES = [
	{ value: "passive", meaning: "The rule matched the structure of the value alone." },
	{ value: "active", meaning: "The rule also required confirming context around the value, such as an assignment, a keyword or a header." },
];

/**
 * The metrics every secret scanner stores: how many leaks, how severe, and how
 * sure. `extraLimits` are the limits of the scanner's own method.
 */
export function secretScannerMetrics(analyzerId: string, scannerName: string, extraLimits: string[]): MetricDefinition[] {
	return [
		{
			id: `${analyzerId}.leak`,
			name: `${scannerName} leaks`,
			definition: `A string in a session transcript that the ${scannerName} rule catalogue matches as a credential, after allowlisting and the severity filter.`,
			measurement: "rule-based",
			unit: "leaks per session",
			denominator: "none: the node stores the count and the number of messages scanned",
			limitations: [
				...extraLimits,
				LIMIT_DETECTION,
				LIMIT_SCAN_LANGUAGE,
				LIMIT_REDACTED,
				LIMIT_SCAN_FIELDS,
				LIMIT_CAPS,
				LIMIT_ALLOWLIST,
				LIMIT_HARNESS,
			],
		},
		{
			id: `${analyzerId}.leak-severity`,
			name: `${scannerName} leak severity`,
			definition: "The severity that the matching rule declares for a leak.",
			measurement: "rule-based",
			unit: "leaks per severity",
			denominator: "leaks of the session",
			values: SEVERITY_VALUES,
			limitations: [
				"The severity belongs to the rule and not to the value found, so two leaks from one rule share a severity whether or not the credential is live.",
				"A configured severity floor removes lower severities before they count.",
			],
		},
		{
			id: `${analyzerId}.leak-confidence`,
			name: `${scannerName} leak confidence`,
			definition: "Whether the matching rule needed context around the value (active) or matched its structure alone (passive).",
			measurement: "rule-based",
			unit: "leaks per confidence",
			denominator: "leaks of the session",
			values: CONFIDENCE_VALUES,
			limitations: [
				"A rule without a declared confidence reads as passive, so passive includes rules that predate the field.",
				"A configured confidence floor removes passive findings before they count.",
			],
		},
	];
}
