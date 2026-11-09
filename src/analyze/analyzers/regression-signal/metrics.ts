import type { MetricDefinition } from "../../metrics/types.js";

export const metrics: MetricDefinition[] = [
	{
		id: "regression-signal.regression-claim",
		name: "Regression claim",
		definition:
			"A session that repaired a defect and states the defect came from an earlier change, whether or not it names that change.",
		measurement: "rule-based",
		unit: "sessions per corpus",
		denominator: "sessions with a claim",
		values: [
			{ value: "claims_regression", meaning: "The label: a defect was repaired and attributed to an earlier change." },
			{ value: "names_the_cause", meaning: "The claim names a pull request or commit, so an attribution join can follow it." },
			{ value: "blames_upstream", meaning: "The session blames a vendor, SDK or released dependency rather than an earlier change of ours." },
			{ value: "never_worked", meaning: "The session says the defect never worked, which makes it a new defect, not a regression." },
		],
		limitations: [
			"Reads the transcript only. Whether the blamed change really introduced the defect needs the tree, and is not decided here.",
			"A denial is not a claim: the corpus's most common form of \"caused by\" is an agent proving its own change was not the cause, and those sentences are excluded.",
			"Provenance prose reads like causality (\"the numbers came from that pull request\"), so a citation requires a pull request number and defect context in one sentence.",
			"A citation is the cause, never the cure: \"caused by X and fixed in PR 2274\" names 2274 as the repair.",
			"A session that only discusses someone else's regression changes nothing, so it files no claim.",
			"\"regression test\", \"prompt-regression\" and \"visual regression\" name a test kind or a suite, and are stripped before matching.",
		],
		seriesBreaks: [
			{
				version: "1.1",
				effect:
					"`claims_regression` no longer requires a named cause, so sessions that state a mechanism without a pull request number gain a node.",
				repair: "prospect analyze --analyzer regression-signal --all",
			},
		],
	},
];
