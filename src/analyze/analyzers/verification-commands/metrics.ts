import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_VERSIONS } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "verification-commands.verdict",
		name: "Verification verdict",
		definition: "The judgement on one distinct shell command line: whether it verifies the working tree, and how widely.",
		measurement: "inferred",
		unit: "distinct commands per verdict",
		denominator: "none",
		values: [
			{ value: "full", meaning: "Checks the whole project: the full test suite, the gate or CI script, a full build or type check." },
			{ value: "narrow", meaning: "Checks part of the project: one test file, one linted package." },
			{ value: "not_verification", meaning: "Is not a check." },
		],
		limitations: [
			"A decision model judges each command line once for the whole corpus, so a verdict reflects the model of the day the command first ran and lasts until a revise run recomputes it.",
			"The full command line goes to the model, so the README says so.",
			"Stale-verification reads the verdict to name the full checks in its advice. It does not use the verdict to decide what a verification run is.",
			LIMIT_VERSIONS,
		],
	},
];
