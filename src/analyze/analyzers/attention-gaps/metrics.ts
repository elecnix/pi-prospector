import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_HARNESS, LIMIT_PARALLEL, LIMIT_USER_ROLE, LIMIT_VERSIONS } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "attention-gaps.gap",
		name: "Attention gap",
		definition: "The time from the agent's last activity (its latest assistant message or tool result) to a message a person typed.",
		measurement: "counted",
		unit: "seconds per gap, summarised per session as count, median, 90th percentile, maximum and buckets",
		denominator: "typed messages whose origin a rule or the decision model settled",
		limitations: [
			"A long gap means the agent sat idle for a person. It doesn't say the person was busy elsewhere, or that they supervise less.",
			"A typed message with no earlier agent activity (the first turn) or no timestamp has no gap. The node counts these as unmeasured and never reads them as zero seconds.",
			"A message whose origin node is undecided keeps a provisional typed label. Its gap is counted apart and left out of the statistics, so the figures are lower bounds on attention.",
			"Only typed messages count. A person who pastes a reply or answers through another agent shows no gap.",
			LIMIT_USER_ROLE,
			LIMIT_HARNESS,
			LIMIT_PARALLEL,
			LIMIT_VERSIONS,
		],
	},
	{
		id: "attention-gaps.typed-messages",
		name: "Typed messages",
		definition: "The messages in a session that message-origin settled as typed, which are the only ones the gap statistics read.",
		measurement: "rule-based",
		unit: "messages per session",
		denominator: "none",
		limitations: [
			"A session with no typed message has every count at zero. It is the sessions that ran with no person involved, and a share of sessions that wait on a person needs them in its denominator.",
			"The count inherits the limits of the message origin label: a prompt an orchestrator wrote for a worker can read as typed.",
		],
	},
];
