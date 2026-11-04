import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_HARNESS } from "../../metrics/limits.js";

const SCORE_LIMITS = [
	"The score is a ranking and contrast feature and is not an outcome label: a session can follow the plan and fail, or skip it and succeed.",
	"It is a function of the phase sequence that phase-trajectory produced, so it inherits that classifier's limits.",
	"A project that verifies its work in a way the classifier does not recognise reads as skipping the validate phase, and a report of sessions that skip validation can reflect that artefact more than a habit.",
	LIMIT_HARNESS,
];

export const metrics: MetricDefinition[] = [
	{
		id: "plan-compliance.plan-phase-compliance",
		name: "Plan phase compliance (PPC)",
		definition: "The share of the canonical plan phases that appear in a session's phase sequence.",
		measurement: "rule-based",
		unit: "score from 0 to 1 per session",
		denominator: "canonical plan phases",
		limitations: ["It penalises skipped phases. An empty sequence scores 0.", ...SCORE_LIMITS],
	},
	{
		id: "plan-compliance.plan-order-compliance",
		name: "Plan order compliance (POC)",
		definition: "One minus the share of transitions between distinct plan phases that move backwards through the canonical order.",
		measurement: "rule-based",
		unit: "score from 0 to 1 per session",
		denominator: "transitions between distinct plan phases",
		limitations: [
			"Consecutive turns in one phase are not a transition, and the `other` phase sits outside the plan, so an interruption that resumes the same phase is not disorder.",
			"With no transition there is no disorder, so the score is 1.",
			...SCORE_LIMITS,
		],
	},
	{
		id: "plan-compliance.plan-phase-fidelity",
		name: "Plan phase fidelity (PPF)",
		definition: "The share of a session's turns that fall in a plan phase and not in `other`.",
		measurement: "rule-based",
		unit: "score from 0 to 1 per session",
		denominator: "turns of the session",
		limitations: ["It penalises out-of-plan behaviour. An empty sequence scores 0.", ...SCORE_LIMITS],
	},
	{
		id: "plan-compliance.plan-compliance",
		name: "Plan compliance (PC)",
		definition: "The geometric mean of PPC, POC and PPF. It is 1 only when a session executes all and only the canonical phases, in order.",
		measurement: "rule-based",
		unit: "score from 0 to 1 per session",
		denominator: "none",
		limitations: ["A zero in any of the three parts makes the mean zero.", ...SCORE_LIMITS],
	},
];
