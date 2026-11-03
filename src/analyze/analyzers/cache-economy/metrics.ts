import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_HARNESS } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "cache-economy.cache-hit-ratio",
		name: "Cache hit ratio",
		definition: "For one billed assistant turn, cache-read tokens divided by the sum of cache-read, cache-write and fresh input tokens. The session aggregate sums the tokens before dividing.",
		measurement: "counted",
		unit: "ratio from 0 to 1, per turn and per session",
		denominator: "cache-read, cache-write and input tokens of the turn, or of all turns with recorded usage",
		limitations: [
			"A turn that recorded no usage is unbilled and unknown. It is counted as such and never as a ratio of zero.",
			"A harness that does not record cache tokens yields a null ratio. Claude Code writes one row per content block, so usage is de-duplicated by provider message id before it is summed.",
			LIMIT_HARNESS,
		],
	},
	{
		id: "cache-economy.cache-classification",
		name: "Cache turn classification",
		definition: "The class of one billed turn by how its prompt cache behaved, including the cause of a cold miss.",
		measurement: "rule-based",
		unit: "turns per class",
		denominator: "billed assistant turns",
		values: [
			{ value: "hit", meaning: "The ratio is at or above the configured healthy threshold." },
			{ value: "cold-ttl", meaning: "The cache missed after a gap longer than the cache lifetime, so the prefix was rebuilt from scratch." },
			{ value: "cold-prefix", meaning: "The cache missed although the turn followed promptly, so something near the front of the context changed." },
			{ value: "cold-start", meaning: "The first billed turn of the session, which has nothing to hit." },
			{ value: "partial", meaning: "A ratio between a hit and a cold miss." },
			{ value: "unbilled", meaning: "The turn recorded no usage." },
		],
		limitations: [
			"The cause of a cold miss is inferred from the gap between turns and the configured lifetime, so a provider with another cache lifetime needs a config change.",
			"The thresholds are config, and a change of thresholds is a config change.",
		],
	},
	{
		id: "cache-economy.write-churn",
		name: "Write churn",
		definition: "Tokens written to the cache that no later turn read before the session ended.",
		measurement: "counted",
		unit: "tokens per session",
		denominator: "none",
		limitations: [
			"A session that ends early shows churn for writes that a later session would have read.",
			"A turn with no recorded usage contributes nothing, and the count is a lower bound.",
		],
	},
	{
		id: "cache-economy.cold-miss-cost",
		name: "Cold miss cost",
		definition: "The billed dollar cost of the turns classified as cold misses (TTL expiry and prefix instability).",
		measurement: "counted",
		unit: "dollars per session",
		denominator: "none",
		limitations: [
			"The index holds one billed total per turn, so the figure is the whole turn's bill and a lower bound of the cache-specific waste.",
			"A turn without a recorded cost is excluded and counted as unpriced, never priced at zero. The node stores how many cold turns were priced. The figure is null when none was.",
			"Only some harnesses record a billed cost.",
		],
	},
];
