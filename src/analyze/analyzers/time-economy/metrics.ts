import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_CALL_ID, LIMIT_PARALLEL } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "time-economy.active-time",
		name: "Active time",
		definition: "The union of every timed tool call's span and every gap between messages, with each gap capped at an idle limit (300 seconds by default).",
		measurement: "counted",
		unit: "minutes per session",
		denominator: "none",
		limitations: [
			"The figure is the active_seconds field of the node. The corpus fingerprint reports it as a total in hours and as a per-session distribution, so a total adds up agent time (see the parallel-work limit).",
			"A call without both timestamps is untimed, counted as such and never as zero seconds.",
			"The analyzer may have read only part of a period, so a monthly figure describes the sessions it read.",
			LIMIT_PARALLEL,
			LIMIT_CALL_ID,
		],
		seriesBreaks: [
			{
				version: "2.0",
				effect: "Background calls are timed by the host's completion record and not by their acknowledgement, so durations rise for sessions with background calls.",
				repair: "prospect analyze --analyzer time-economy --revise major",
			},
		],
	},
	{
		id: "time-economy.phase-span",
		name: "Phase spans",
		definition: "The stretch between two markers in the work: from the start to the first commit, and from the start of a commit's preparation to the commit.",
		measurement: "counted",
		unit: "minutes, turns and tokens per span",
		denominator: "none",
		limitations: [
			"A session that never committed has a start-to-first-commit span that ends at the session's end, and says so.",
			"Tokens are unknown, never zero, when the transcript recorded no usage for the window.",
		],
	},
];
