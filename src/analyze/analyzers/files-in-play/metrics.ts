import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_HARNESS } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "files-in-play.distinct-files",
		name: "Distinct files in play",
		definition: "The number of distinct files that a session's read, edit and write tool calls touched.",
		measurement: "counted",
		unit: "files per session",
		denominator: "none",
		limitations: [
			"Paths come from structured tool arguments and from bash commands, so a file touched in a way neither shows is missed.",
			LIMIT_HARNESS,
		],
	},
	{
		id: "files-in-play.reread-events",
		name: "Re-read events",
		definition: "The number of reads of a file the session had already read.",
		measurement: "counted",
		unit: "reads per session",
		denominator: "reads (the node stores the read count)",
		limitations: [
			"A re-read after an edit can be legitimate verification, and the count does not separate it from waste.",
		],
	},
	{
		id: "files-in-play.edit-reread-cycles",
		name: "Read, edit, read cycles",
		definition: "The number of times the agent read a file, edited it, and read it again, summed over files.",
		measurement: "counted",
		unit: "cycles per session",
		denominator: "none",
		limitations: ["A cycle is a pattern in the order of calls and is not proof that the agent was wrong."],
	},
	{
		id: "files-in-play.churn-score",
		name: "Churn score",
		definition: "The share of sliding windows of consecutive file interactions in which the repeat ratio reached the configured level, so the agent kept reopening files already in the window.",
		measurement: "rule-based",
		unit: "fraction from 0 to 1",
		denominator: "evaluated windows",
		limitations: [
			"windowSize, churnRepeatRatio and the proposal thresholds are config, so a change of config moves the score.",
			"A session with fewer interactions than one window has no evaluated window.",
			"Work over a small set of files looks like churn even when it makes progress.",
		],
	},
];
