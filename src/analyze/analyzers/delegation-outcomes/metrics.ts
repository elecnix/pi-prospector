import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_CALL_ID, LIMIT_HARNESS, LIMIT_VERSIONS } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "delegation-outcomes.outcome",
		name: "Delegation outcome",
		definition: "How the host recorded the end of a call that hands work to a child agent, decided in order: no result, then a background-task completion, then the error flag on the result, then Pi's orchestration classification.",
		measurement: "rule-based",
		unit: "delegation calls per outcome",
		denominator: "delegation calls: calls to the configured delegation tools (Task, Agent, subagent by default)",
		values: [
			{ value: "completed", meaning: "The host did not report a failure. It does not say the child's work was right." },
			{ value: "failed", meaning: "The background completion says failed, the result is flagged as an error, or Pi classified the result as a child failure." },
			{ value: "killed", meaning: "The background completion says the child was stopped before it finished." },
			{ value: "revived", meaning: "Pi classified the call as resuming an earlier run." },
			{ value: "unanswered", meaning: "No result ever arrived: the parent stopped waiting or the session ended first." },
			{ value: "other", meaning: "A background status the analyzer does not know." },
		],
		limitations: [
			"Completed is the absence of a reported failure, so a child that returned wrong work reads as completed.",
			"A background completion with no status does not decide, and the call falls to the result's own flags.",
			"A retry is seen only where Pi classifies it as a revival. A Claude Code call repeated with a new prompt after a failure reads as two calls.",
			"The listed events are capped by config (200 by default). The counts and the edges to the calls always cover every call.",
			LIMIT_CALL_ID,
			LIMIT_HARNESS,
			LIMIT_VERSIONS,
		],
	},
	{
		id: "delegation-outcomes.work-moved-to-children",
		name: "Work moved to children",
		definition: "The sessions of child agents that name a session as their parent, with the messages they contain, beside the parent's own message count.",
		measurement: "counted",
		unit: "child sessions and child messages per parent session",
		denominator: "the parent's own message count, for a share",
		limitations: [
			"A fork is not a child: a pi session forked from the parent copies its history and is never counted. A pi child run counts, from its parent link (#416).",
			"A pi child run indexed before its parent link was recorded counted as no child. Its parent's node is redrawn by a plain run over every session: prospect analyze --analyzer delegation-outcomes --all.",
			"It measures volume and not value. A child that read a file counts as much as a child that wrote a feature.",
			"The totals are read when the node is computed. A child session synced later changes the unit and the next plain run adds a node.",
			LIMIT_HARNESS,
		],
	},
];
