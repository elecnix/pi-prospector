import type { MetricDefinition } from "../../metrics/types.js";

export const metrics: MetricDefinition[] = [
	{
		id: "regression-prevention.cause-class-recurrence",
		name: "Cause-class recurrence",
		definition:
			"How often a single kind of mistake produced a regression across the whole corpus, and the change that would have prevented that class.",
		measurement: "counted",
		unit: "regressions per cause class",
		denominator: "regression verdicts",
		values: [
			{ value: "occurrences", meaning: "Regression verdicts in this class at or above the confidence floor." },
			{ value: "severity", meaning: "The class's share of the largest class: high, medium or low." },
			{ value: "mean_confidence", meaning: "The average confidence of the verdicts behind the count." },
		],
		limitations: [
			"Counts verdicts, not incidents: two verdicts for one defect count twice, and a defect repaired without a verdict counts not at all.",
			"A class below the occurrence threshold files nothing, so absence of a proposal is not evidence the class does not occur.",
			"The prevention prose is written per class in advance, not generated per corpus, so it names the change a class argues for rather than a specific diff.",
			"Severity ranks classes against each other, not against an absolute standard: a corpus with one class calls that class high whatever its count.",
			"Reads the graph only. It calls no model, so it cannot disagree with the verdicts it groups.",
		],
	},
];
