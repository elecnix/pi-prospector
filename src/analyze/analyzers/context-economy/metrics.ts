import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_HARNESS } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "context-economy.carry-cost",
		name: "Carry cost of a tool result",
		definition: "The tokens of a tool result multiplied by the turns that re-send it as cache-read before the next compaction or the end of the session.",
		measurement: "counted",
		unit: "token-turns per result, and dollars when the turns carry a cost breakdown",
		denominator: "none",
		limitations: [
			"Token counts are estimated from stored character lengths with a configurable characters-per-token ratio. The turn counts are exact.",
			"The dollar figure re-prices the result at each turn's implied cache-read rate. A turn without a per-bucket cost breakdown is excluded and counted, never priced at zero.",
			"Carry stops at the next compaction, so a session that compacts early shows a lower carry for the same reads.",
			LIMIT_HARNESS,
		],
		seriesBreaks: [
			{
				version: "2.2",
				effect: "High-carry results are also priced in dollars, so earlier nodes lack the dollar fields.",
				repair: "prospect analyze --analyzer context-economy --revise minor",
			},
		],
	},
	{
		id: "context-economy.waste-flag",
		name: "Context waste flag",
		definition: "A tool result or read that the analyzer flags as a likely waste of carried context.",
		measurement: "rule-based",
		unit: "flags per session",
		denominator: "sessions",
		values: [
			{ value: "high-carry-result", meaning: "A result whose carry cost is above the configured threshold." },
			{ value: "oversized-tool-result", meaning: "A result larger than the configured size." },
			{ value: "redundant-read", meaning: "The same file read again with an overlapping byte range." },
		],
		limitations: [
			"The thresholds are config.",
			"A re-read after an edit can be a legitimate check, and the rule reads only byte ranges.",
		],
		seriesBreaks: [
			{
				version: "2.1",
				effect: "Redundant-read detection is slice-aware, so paginated reads of one large file no longer count as duplicates and the flag count falls.",
				repair: "prospect analyze --analyzer context-economy --revise minor",
			},
		],
	},
	{
		id: "context-economy.compaction-policy",
		name: "Compaction policy",
		definition: "Per compaction cycle, the carry the compaction avoided against the tokens needed to rebuild context, with flags for a compaction that fired too late or too often. The carry avoided is a lower bound.",
		measurement: "rule-based",
		unit: "cycles per session, with token-turns avoided and tokens rebuilt per cycle",
		denominator: "compaction cycles",
		values: [
			{ value: "firedTooLate", meaning: "The cycle spanned at least the configured number of turns and an earlier compaction would have avoided at least the configured carry." },
			{ value: "firedTooOften", meaning: "The rebuild after the compaction reached the configured size while the carried context at the flush was no larger than the rebuild." },
		],
		limitations: [
			"The verdict depends on config thresholds and on estimated token counts.",
			"A session that never compacted is recorded as such and has no cycles.",
		],
		seriesBreaks: [
			{
				version: "2.0",
				effect: "The node judges compaction policy and not only accounts for it. Nodes of version 1.2 and earlier lack the cycle fields.",
				repair: "prospect analyze --analyzer context-economy --revise major",
			},
		],
	},
];
