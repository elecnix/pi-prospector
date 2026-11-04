import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_CALL_ID } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "compression-checklist.facet-coverage",
		name: "Summary facet coverage",
		definition: "For each compaction summary, how many of four checklist facets it covers: conclusions present, source references retained, unresolved items, and abandoned directions.",
		measurement: "rule-based",
		unit: "facets covered per summary (0 to 4); a session reports fully covered summaries as a count",
		denominator: "compaction summaries",
		values: [
			{ value: "conclusions_present", meaning: "The summary states conclusions." },
			{ value: "source_references", meaning: "The summary keeps the source references (leads) the flushed cycle surfaced, counted as retained leads out of total leads." },
			{ value: "unresolved_items", meaning: "The summary contains a cue for items still open." },
			{ value: "abandoned_directions", meaning: "The summary contains a cue for directions the agent dropped." },
		],
		limitations: [
			"The unresolved and abandoned facets match wording cues, so a summary in another language or another style fails them.",
			"A session that never compacted has no node.",
		],
	},
	{
		id: "compression-checklist.leads-lost",
		name: "Leads lost across a compaction",
		definition: "The number of leads that were surfaced before a compaction, absent from its summary, and used again afterwards: the agent lost them or had to re-derive them.",
		measurement: "rule-based",
		unit: "leads per session",
		denominator: "leads surfaced in the flushed cycle (the node stores total and retained leads per summary)",
		limitations: [
			"Each summary is graded over its own cycle only, and a use after the next compaction is not matched, so the count is a lower bound.",
			"A lead is matched literally, as in uncompleted-leads.",
			LIMIT_CALL_ID,
		],
		seriesBreaks: [
			{
				version: "1.1",
				effect: "The action stream pairs results with id-less stored calls, so lead loss is graded against the results those calls received.",
				repair: "prospect analyze --analyzer compression-checklist --revise minor",
			},
		],
	},
];
