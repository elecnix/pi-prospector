import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_CALL_ID, LIMIT_HARNESS } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "navigation-efficiency.navigation-pattern",
		name: "Navigation anti-patterns",
		definition: "Per session, the number of episodes in which the agent moved through the repository tree in a wasteful order, although every read succeeded.",
		measurement: "rule-based",
		unit: "episodes per session",
		denominator: "sessions",
		values: [
			{ value: "scroll", meaning: "Consecutive bounded slices of one file that overlap each other without repeating: paging around a point instead of reading its enclosing unit." },
			{ value: "zoom_out", meaning: "A view climbs back up the branch just explored and a later view descends as far again, with no edit between." },
			{ value: "overly_deep_zoom", meaning: "An uninterrupted run of views of one path that is never edited afterwards. Only sessions that edit something are judged." },
			{ value: "repeated_view", meaning: "A return to a structural region after leaving it. A re-read right after a successful edit is verification and does not count; after a failed edit it does." },
		],
		limitations: [
			"Transcripts do not record the working directory, so absolute paths are made relative to the root they share. Only differences in depth matter.",
			"The count stops at maxEpisodes per pattern in the stored list, but the node also stores the full count per pattern.",
			"A pattern proposes only when its episodes reach proposalMinEpisodes, so a single episode is a measurement and not a finding.",
			"The harness decides which tools exist for navigation, so a harness with fewer search tools shows fewer views.",
			LIMIT_CALL_ID,
			LIMIT_HARNESS,
		],
		seriesBreaks: [
			{
				version: "1.1",
				effect: "The action stream pairs results with id-less stored calls, so a failed edit is seen and a re-read after it counts as a repeated view.",
				repair: "prospect analyze --analyzer navigation-efficiency --revise minor",
			},
		],
	},
	{
		id: "navigation-efficiency.structural-edge-count",
		name: "Structural-edge count (SEC)",
		definition: "The number of viewed regions whose nearest viewed ancestor was also viewed: how much of the navigation was descent along the tree and not jumps across it.",
		measurement: "rule-based",
		unit: "regions per session",
		denominator: "none",
		limitations: [
			"It grows with the number of regions viewed, so compare it with the regions-viewed count the node stores.",
			"A region is a directory, a file or a bounded slice of a file.",
			LIMIT_CALL_ID,
		],
	},
	{
		id: "navigation-efficiency.structural-breadth",
		name: "Structural breadth (SB)",
		definition: "The most viewed regions hanging directly under one viewed region. A value above 1 means the agent explored more than one sibling before converging.",
		measurement: "rule-based",
		unit: "regions per session",
		denominator: "none",
		limitations: [
			"A long session has more chances to widen it.",
			"It shows breadth of exploration and does not show whether the exploration was needed.",
		],
	},
];
