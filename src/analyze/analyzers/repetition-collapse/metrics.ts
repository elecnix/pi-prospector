import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_HARNESS } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "repetition-collapse.collapsed-steps",
		name: "Repetition-collapsed steps",
		definition: "The number of assistant steps whose reasoning or answer repeats a phrase or a sub-word fragment until the generation ends.",
		measurement: "rule-based",
		unit: "collapsed steps per session",
		denominator: "judged steps (the node stores the judged step count)",
		values: [
			{ value: "reasoning", meaning: "The loop is in the step's reasoning." },
			{ value: "answer", meaning: "The loop is in the step's answer text." },
		],
		limitations: [
			"The score is the stronger of two ratios, the share of words inside a repeated word n-gram and the longest run of one short character motif. Length is only a floor below which nothing is judged.",
			"The threshold is config, because the same ratio separates loops from prose differently on different endpoints.",
			"The node records the repeating motif and never the looping text.",
			LIMIT_HARNESS,
		],
	},
	{
		id: "repetition-collapse.undelivered-steps",
		name: "Undelivered collapsed steps",
		definition: "Collapsed steps that produced no answer and no tool call: billed in full for nothing.",
		measurement: "rule-based",
		unit: "steps per session",
		denominator: "none: a subset of the collapsed steps of the session",
		limitations: [
			"The dollar cost of these steps is the sum over the priced ones, and it is null when none was priced. An unpriced step contributes nothing, so the total is a lower bound.",
			"An undelivered step earns a routing proposal and escalates its turn in routing-opportunity.",
		],
	},
];
