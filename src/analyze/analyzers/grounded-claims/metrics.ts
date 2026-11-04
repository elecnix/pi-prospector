import type { MetricDefinition } from "../../metrics/types.js";

export const metrics: MetricDefinition[] = [
	{
		id: "grounded-claims.ungrounded-claim",
		name: "Ungrounded claim",
		definition: "A concrete fact that the assistant stated in a turn, such as a number, count, percentage, path or line reference, and that appears nowhere in that turn's tool results.",
		measurement: "rule-based",
		unit: "claims per turn, or per 100 turns",
		denominator: "turn pairs",
		values: [
			{ value: "number", meaning: "A bare number." },
			{ value: "count", meaning: "A count of things, such as a test count." },
			{ value: "percentage", meaning: "A percentage." },
			{ value: "path", meaning: "A file path." },
			{ value: "location", meaning: "A file and line location." },
			{ value: "line-ref", meaning: "A reference to a line number." },
		],
		limitations: [
			"A claim can be true and still absent from the turn's results, for example a number the agent computed or recalled from an earlier turn, so a hit is a candidate for review and not proof of fabrication.",
			"Only that turn's tool results count as grounds. The analyzer cannot check a claim against the workspace.",
			"The check has no thresholds, and the evidence is the discrepancy itself.",
		],
	},
	{
		id: "grounded-claims.unacted-request",
		name: "Unacted request",
		definition: "A concrete actionable request in a user message (run the tests, build, open a pull request, commit, push, delete a named path) that no tool call in that turn or the next satisfied.",
		measurement: "rule-based",
		unit: "requests per turn, or per 100 turns",
		denominator: "turn pairs",
		values: [{ value: "request", meaning: "The claim kind of every unacted request: the trigger sentence of the request." }],
		limitations: [
			"The request patterns match English wording, so a request in another language is not seen.",
			"A request the agent satisfied two or more turns later, or declined with a reason, still counts.",
			"A user message that is a pasted log or an agent's brief can contain request wording the person never wrote.",
		],
	},
];
