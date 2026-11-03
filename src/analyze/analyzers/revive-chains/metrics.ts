import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_CALL_ID } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "revive-chains.redundant-spawns",
		name: "Redundant spawns in revive chains",
		definition: "The number of spawns a persistent multi-turn primitive would have saved: for each maximal run of consecutive revived sub-agent results, the chain length minus one, summed over the session.",
		measurement: "rule-based",
		unit: "spawns per session",
		denominator: "none",
		limitations: [
			"The first spawn of a conversation is not a revive marker and is not counted, so the figure is a lower bound.",
			"A chain ends at any other tool call or at a sub-agent result that is not a revive, so a conversation interleaved with other work reads as several short chains.",
			"The node also stores the chain count, the longest chain and a histogram of chain lengths.",
			LIMIT_CALL_ID,
		],
		seriesBreaks: [
			{
				version: "1.1",
				effect: "The action stream pairs results with id-less stored calls, so a revived child's result and run id are found. The unit fingerprint folds in the outcome, so a re-run fills new nodes beside the old ones and does not replace them.",
				repair: "prospect analyze --analyzer revive-chains --revise minor, then read one node per session",
			},
		],
	},
	{
		id: "revive-chains.usage-split",
		name: "Self and delegated usage",
		definition: "The tokens and billed cost of the parent session's own calls against those of the child runs it started, joined by run id.",
		measurement: "counted",
		unit: "tokens and dollars per session",
		denominator: "none",
		limitations: [
			"A revive marker whose run has no artifact row is unattributed and never counted as zero.",
			"Values the host did not record stay null.",
			"Only some harnesses record a billed cost.",
		],
	},
];
