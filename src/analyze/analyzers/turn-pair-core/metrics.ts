import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_HARNESS, LIMIT_USER_ROLE } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "turn-pair-core.friction-score",
		name: "Friction score and high-signal turn",
		definition: "A number from 0 to 1 for one turn, built as a weighted sum of a detected correction, failed tool results (at most three), an empty reply and oversized tool output. A turn at or above the high-signal threshold is high-signal.",
		measurement: "rule-based",
		unit: "score per turn",
		denominator: "turn pairs, which include non-user turn boundaries such as a bash execution or a branch summary, so the count is not the count of user messages",
		limitations: [
			"A correction matches English wording, so a correction in another language scores zero.",
			"The score ranks turns for escalation and does not limit what a model reads, because every turn keeps a verbatim snippet in the digest.",
			"The weights are config, so a change of weights is a config change.",
			LIMIT_HARNESS,
		],
	},
	{
		id: "turn-pair-core.correction",
		name: "Correction",
		definition: "A turn whose user text matches a correction pattern, such as \"no, use X instead\", \"I told you to\", or a repeated request.",
		measurement: "rule-based",
		unit: "corrections per 100 turn pairs, or per 100 user messages when a report chooses that denominator",
		denominator: "turn pairs, or user messages",
		limitations: [
			"The patterns match English wording only, and a pasted log that contains one counts.",
			"The two denominators differ, so a report states the one it used.",
			LIMIT_USER_ROLE,
		],
	},
	{
		id: "turn-pair-core.rebuttal-candidate",
		name: "Rebuttal candidate",
		definition: "A turn whose user text matches wording that disputes something the assistant said.",
		measurement: "rule-based",
		unit: "candidates per turn pair",
		denominator: "turn pairs",
		limitations: [
			"A match is a candidate and not yet a finding. The model layer in turn-pair-llm confirms or rejects it, and a confirmed candidate is a rebuttal.",
		],
	},
];
