import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_HARNESS, LIMIT_PARALLEL, LIMIT_VERSIONS } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "activity-windows.active-time",
		name: "Activity windows",
		definition: "The stretches of wall-clock time a session was running: each gap between two messages up to the idle cap (300 seconds by default) and the whole span of every timed tool call, merged into windows that never overlap.",
		measurement: "counted",
		unit: "seconds per session (active_seconds), and the windows themselves",
		denominator: "none",
		limitations: [
			"The idle cap decides what counts as running. A person who read for ten minutes between two messages shows five minutes of activity.",
			"A call with no timestamp on either end adds nothing, and the node counts messages without a timestamp instead of treating them as instant.",
			"The figure shares its idle cap with time-economy's active time but is computed apart, and a changed cap in one does not move the other.",
			LIMIT_PARALLEL,
			LIMIT_HARNESS,
			LIMIT_VERSIONS,
		],
	},
	{
		id: "activity-windows.concurrency",
		name: "Concurrent sessions",
		definition: "How many sessions were active at the same moment, folded at read time from every session's windows into one row per hour or day: distinct sessions, the peak active at once, and the summed minutes.",
		measurement: "counted",
		unit: "sessions per hour or day, peak sessions at once, and agent minutes",
		denominator: "none",
		limitations: [
			"No node stores it. It belongs to the corpus, so the `activity-windows:concurrency` output computes it on each render from the newest node per session. A session not analysed yet is missing from the count.",
			"Times are UTC. A day or hour boundary falls elsewhere on a person's clock.",
			"The summed minutes are agent time and not the person's time, and exceed it whenever sessions overlap.",
			"Two sessions that only touch at an instant are not counted as overlapping.",
			LIMIT_PARALLEL,
		],
	},
];
