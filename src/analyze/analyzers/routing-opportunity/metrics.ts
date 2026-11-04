import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_CALL_ID, LIMIT_HARNESS, LIMIT_VERSIONS } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "routing-opportunity.routing-verdict",
		name: "Routing verdict",
		definition: "The label of one turn, set with the outcome in hand: whether a cheaper model would probably have served it, or the turn's model failed and retried.",
		measurement: "rule-based",
		unit: "turns per verdict",
		denominator: "turns",
		values: [
			{ value: "downshift", meaning: "The turn showed every marker of being easy: few tool calls, small context, a bounded edit, little deliberation, no correction and no trajectory pathology." },
			{ value: "escalate", meaning: "A correction, a trajectory pathology (stuck-loop, oscillation or pre-flight gap) or a collapse into repetition shows that the turn's model failed and retried." },
			{ value: "neutral", meaning: "Neither." },
		],
		limitations: [
			"The label is structural and independent of the model. Whether an easy turn ran on an expensive model is a question for the model-mix fold, which pairs the label with recorded cost.",
			"The verdict comes from other analyzers' signals, so it inherits their limits: correction wording matches English, and a trajectory signal depends on pairing calls with results.",
			"The frustration marker reads the hits that count: current generation, unmuted and priced by term specificity.",
			LIMIT_CALL_ID,
			LIMIT_HARNESS,
			LIMIT_VERSIONS,
		],
		seriesBreaks: [
			{
				version: "1.2",
				effect: "A step that collapsed into repetition escalates its turn, so more turns read escalate.",
				repair: "prospect analyze --analyzer routing-opportunity --revise minor",
			},
			{
				version: "1.3",
				effect: "The frustration marker reads the hits that count instead of every live hit, so a background word or a muted term no longer marks a turn as frustrated.",
				repair: "prospect analyze --analyzer routing-opportunity --revise minor",
			},
		],
	},
	{
		id: "routing-opportunity.turn-cost",
		name: "Routing turn model and cost",
		definition: "The serving model of a turn and the billed cost of its assistant steps, attached to the verdict.",
		measurement: "counted",
		unit: "dollars per turn",
		denominator: "none",
		limitations: [
			"A turn whose model was never recorded carries the model name `unrecorded`, which is a coverage gap and not a model.",
			"The cost is null when no step of the turn recorded a billed amount. Money is never invented.",
			"A routed alias hides the model that answered.",
		],
	},
];
