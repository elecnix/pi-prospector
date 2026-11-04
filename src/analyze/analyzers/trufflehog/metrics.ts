import type { MetricDefinition } from "../../metrics/types.js";
import { secretScannerMetrics } from "../../metrics/security.js";

const BASE = secretScannerMetrics("trufflehog", "trufflehog", [
	"The catalogue is self-written for newer provider token patterns over the shared engine, and it carries no upstream trufflehog code. It covers a small set of providers.",
]);

export const metrics: MetricDefinition[] = [
	...BASE,
	{
		id: "trufflehog.verification",
		name: "trufflehog live verification",
		definition: "The outcome of an optional check that sends a found credential to its issuing provider to learn whether it is live.",
		measurement: "rule-based",
		unit: "leaks per outcome",
		denominator: "leaks of the session, including those no verifier claims (unverified)",
		values: [
			{ value: "verified_true", meaning: "The provider confirmed the credential as live." },
			{ value: "verified_false", meaning: "The provider explicitly rejected the credential." },
			{ value: "verified_unknown", meaning: "The outcome could not be determined: a network error, a timeout or an unexpected status." },
			{ value: "unverified", meaning: "No enabled verifier claims the shape of the value." },
		],
		limitations: [
			"Verification runs only when the config turns it on, and the node records whether it ran. Without it, every leak is unverified, so an unverified count describes a scan that never asked.",
			"Verification sends the credential to the provider, so enabling it is a decision about where the value goes. The node stores the outcome and a fixed reason, never the provider's response text.",
			"One probe serves every repeat of the same value and verifier, so the number of probes issued is lower than the number of leaks verified.",
			"A live credential can read as rejected after it is rotated between the leak and the check, and a network failure reads as unknown and never as rejected.",
		],
	},
];
