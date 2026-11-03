import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_HARNESS } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "message-origin.origin",
		name: "Message origin",
		definition: "Who wrote a turn-starting user-role message, as one label for the whole message.",
		measurement: "rule-based",
		unit: "messages per label",
		denominator: "turn-starting user-role messages",
		values: [
			{ value: "typed", meaning: "A person composed or dictated the words. This is also the provisional label of an undecided message." },
			{ value: "pasted", meaning: "A person sent copied material, such as a log, a terminal capture, a quoted reply or a bare link." },
			{ value: "agent", meaning: "An agent or a script wrote it: a child agent's prompt, an orchestrator's brief, a relayed message." },
			{ value: "notification", meaning: "The harness or an extension injected it: a monitor event, a task notification, an interruption notice." },
		],
		limitations: [
			"Named rules decide almost every message. A message with only a weak sign of machine authorship is undecided, and a decision model settles it when one is configured. Without a decision model the node says decided is false and keeps the provisional label typed, so typed is an upper bound.",
			"A prompt that an orchestrator wrote for a worker carries no tag a rule could see, so some agent messages read as typed.",
			"The label covers whole messages. The origin of a frustration hit labels the spans inside a message and can differ.",
			LIMIT_HARNESS,
		],
	},
];
