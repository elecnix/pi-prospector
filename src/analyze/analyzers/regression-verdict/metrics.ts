import type { MetricDefinition } from "../../metrics/types.js";

export const metrics: MetricDefinition[] = [
	{
		id: "regression-verdict.verdict",
		name: "Regression verdict",
		definition:
			"A model's judgement of one gated session: whether it repaired a defect, whether a regression, what kind of mistake let the defect in, and what would have prevented it.",
		measurement: "inferred",
		unit: "verdicts per corpus",
		denominator: "sessions admitted by the gate",
		values: [
			{ value: "fixes_defect", meaning: "The session repaired broken behaviour rather than adding to it." },
			{ value: "is_regression", meaning: "An earlier change introduced the defect, so the behaviour used to work." },
			{ value: "cause_class", meaning: "The kind of mistake, from a closed set, so a retrospective can count it." },
			{ value: "prevention_class", meaning: "The kind of change that would have prevented it." },
			{ value: "cause_provenance", meaning: "stated, inferred or unstated: how far the evidence supports the cause." },
		],
		limitations: [
			"A model judged the session. Mean confidence in a large corpus sits near 0.6, so the counts are a signal for where to look rather than ground truth.",
			"An unstated cause is a recorded answer. The model is told that inventing a plausible cause corrupts the retrospective, so a null cause is not a missing value.",
			"Only sessions the deterministic gate admitted are judged: a session that changed nothing, or saw no failure and named no defect, has no verdict and no node.",
			"The verdict classifies the kind of mistake, never a person. Only the kind can be changed.",
			"Evidence quotes are checkable against the transcript but are not always verbatim: some restate the source text.",
		],
		seriesBreaks: [
			{
				version: "1.1",
				effect:
					"The taxonomy splits the former `assumption_about_input` bucket into `incomplete_match`, `wrong_operator` and `scope_too_wide`, so counts per class are not comparable across the break.",
				repair: "prospect analyze --analyzer regression-verdict --revise minor",
			},
		],
	},
];
