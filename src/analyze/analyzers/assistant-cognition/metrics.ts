import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_VERSIONS } from "../../metrics/limits.js";

const SHARED = [
	"A model reads the assistant's thinking trace and response text, so a model that did not reason is read only through its response, and the signal set depends on the model that answered. The resolved model is recorded on the node.",
	"Hosts may drop or shorten the thinking trace, so a missing trace is unknown and never evidence of no confusion.",
	LIMIT_VERSIONS,
];

export const metrics: MetricDefinition[] = [
	{
		id: "assistant-cognition.confusion",
		name: "Assistant confusion",
		definition: "Whether the assistant's own thinking or response shows it did not understand the situation in one turn, with a graded level.",
		measurement: "inferred",
		unit: "turns with the signal, per level",
		denominator: "analysed turns: the turns with a substantive thinking trace or a deterministic apology match, not all turns",
		values: [
			{ value: "mild", meaning: "A hint of confusion." },
			{ value: "moderate", meaning: "Clear confusion." },
			{ value: "high", meaning: "Strong confusion." },
		],
		limitations: ["The level is a judgement with no quote behind it.", ...SHARED],
	},
	{
		id: "assistant-cognition.indecision",
		name: "Assistant indecision",
		definition: "Whether the assistant flip-flops between options in one turn, with a graded level.",
		measurement: "inferred",
		unit: "turns with the signal, per level",
		denominator: "analysed turns",
		values: [
			{ value: "mild", meaning: "A hint of flip-flopping." },
			{ value: "moderate", meaning: "Clear flip-flopping." },
			{ value: "high", meaning: "Strong flip-flopping." },
		],
		limitations: ["The level is a judgement with no quote behind it.", ...SHARED],
	},
	{
		id: "assistant-cognition.surprise",
		name: "Assistant surprise",
		definition: "A passage of the thinking trace or response where the assistant expresses surprise, with a severity and a quote.",
		measurement: "inferred",
		unit: "surprise signals per turn",
		denominator: "analysed turns",
		limitations: [
			"The quote is validated as an exact substring of the thinking or response text before it is stored, so every signal traces to verbatim evidence. The signal itself is still the model's judgement.",
			...SHARED,
		],
	},
	{
		id: "assistant-cognition.apology",
		name: "Assistant apology",
		definition: "A passage of the response where the assistant concedes it was wrong, with a severity and a quote validated against the response text.",
		measurement: "inferred",
		unit: "apology signals per turn",
		denominator: "analysed turns",
		limitations: [
			"A deterministic match on the response text admits a turn to the analyzer, so an apology is found even when there is no thinking trace. The match is a gate for scrutiny and never a finding.",
			"An apology with no preceding user rebuttal marks an error the assistant caught itself. It is not the same as a user correction.",
			"Nodes of version 1.0 have no apology field, so an apology count over a window that crosses 1.1 compares different signal sets.",
			...SHARED,
		],
		seriesBreaks: [
			{
				version: "1.1",
				effect: "The apology signal exists, and a turn with an apology match is analysed even with an empty thinking trace. Earlier nodes cannot show an apology, and the analysed population grows.",
				repair: "prospect analyze --analyzer assistant-cognition --revise minor (costs model calls)",
			},
		],
	},
];
