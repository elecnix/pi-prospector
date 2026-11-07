import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_VERSIONS } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "message-answers.answer",
		name: "Message answer",
		definition: "A decision model's answer, with its probability distribution, to one registered question about one user-role message whose origin is settled.",
		measurement: "inferred",
		unit: "answers per question",
		denominator: "asked messages: the messages whose origin is settled and whose question accepts that origin",
		limitations: [
			"The analyzer plans nothing without a configured decision model, so a corpus without one has no answers and every consumer reads unknown.",
			"An answer is keyed by question id and version. A question edited without a version bump is asked again, and a re-versioned question is asked on the next config revise while the other answers are carried forward.",
			"The distribution is the model's own, so a probability is not a calibrated frequency.",
			"A message whose origin is undecided is not asked.",
			LIMIT_VERSIONS,
		],
	},
];
