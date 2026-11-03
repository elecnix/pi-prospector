import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_HARNESS, LIMIT_PARALLEL, LIMIT_USER_ROLE } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "attention-gaps.wait",
		name: "Attention gap",
		definition: "The time from the agent's last activity (an assistant message or a tool result) to the next user-role message that message-origin settled as typed.",
		measurement: "counted",
		unit: "seconds per gap, as count, median, 90th percentile, maximum and buckets per session",
		denominator: "none",
		limitations: [
			"A gap needs a timestamp on both ends. A typed message with no timestamp, or with no earlier agent activity (the first turn), has no gap. The node counts it in unmeasured_typed_count and never as zero seconds.",
			"Only a settled typed label counts. A message whose origin is undecided keeps the provisional label typed, and its gap goes to undecided_gap_count outside the statistics, so the statistics describe the messages a rule or the decision model placed.",
			"The clock stops at the message the person sent. A person who read the result at once and took an hour to write the reply counts as an hour of waiting.",
			LIMIT_USER_ROLE,
			LIMIT_PARALLEL,
			LIMIT_HARNESS,
		],
	},
	{
		id: "attention-gaps.waiting-sessions",
		name: "Sessions that waited on a person",
		definition: "The share of sessions whose attention-gaps node has a typed_message_count above zero.",
		measurement: "rule-based",
		unit: "share of sessions",
		denominator: "sessions with an attention-gaps node: every session with messages whose user-role messages all have a message-origin node",
		limitations: [
			"A session with messages but no settled typed message gets a node with zero counts, so it stays in the denominator. One that still lacks its message-origin nodes is absent from the count until that dependency runs.",
			"A prompt that an orchestrator wrote for a worker can read as typed, so a worker session can count as waiting on a person.",
			LIMIT_HARNESS,
		],
	},
];
