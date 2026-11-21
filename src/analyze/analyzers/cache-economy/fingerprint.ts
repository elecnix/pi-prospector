import { type FingerprintContributor, type FingerprintRow } from "../../../fingerprint/contributor.js";

/** The classes of an assistant turn by how its prompt cache behaved: cache-economy's closed set. */
const CACHE_CLASSES = ["hit", "cold-ttl", "cold-prefix", "cold-start", "partial", "unbilled"];

/**
 * How well a session's prompt cache served it. Counted from the host's usage
 * records, so objective. A session that recorded no usage has no hit rate: it
 * is left out of the distribution, never read as a rate of 0.
 */
export const cacheEconomyFingerprint: FingerprintContributor = {
	def: {
		id: "promptCache",
		label: "Prompt cache",
		description:
			"Cache hit rate per session (cache-read tokens over all input tokens), assistant turns by how the cache behaved, cache writes no later turn read, and the cost of cold misses where turns carry a price.",
		kind: "objective",
		analyzers: ["cache-economy"],
		measures: [
			{ kind: "distribution", id: "hitRate", metric: "cache-economy.cache-hit-ratio", field: "hitPercent", unit: "percent", edges: [0, 25, 50, 75, 90, 95] },
			{ kind: "groups", id: "turnsByClass", metric: "cache-economy.cache-classification", dimensions: { class: CACHE_CLASSES }, countField: "turns" },
			{ kind: "total", id: "writeChurnMillions", metric: "cache-economy.write-churn", field: "churn", divisor: 1_000_000, decimals: 2 },
			{ kind: "total", id: "coldMissUsd", metric: "cache-economy.cold-miss-cost", field: "coldUsd", decimals: 2 },
		],
	},
	async read(ctx) {
		const counts = Object.fromEntries(CACHE_CLASSES.map((c) => [c, `$.classification_counts."${c}"`]));
		const nodes = await ctx.nodes("cache-economy", {
			recorded: "$.usage_recorded_turn_count",
			ratio: "$.aggregate_hit_ratio",
			churn: "$.write_churn_tokens",
			coldUsd: "$.cold_miss_cost_usd",
			...counts,
		});
		const rows: FingerprintRow[] = [];
		for (const node of nodes) {
			const session = node["session"]!;
			const recorded = Number(node["recorded"]) > 0 && typeof node["ratio"] === "number";
			rows.push({ session, hitPercent: recorded ? Math.round(Number(node["ratio"]) * 10_000) / 100 : null, churn: node["churn"] ?? null, coldUsd: node["coldUsd"] ?? null });
			for (const c of CACHE_CLASSES) if (typeof node[c] === "number") rows.push({ session, class: c, turns: node[c] });
		}
		return { measured: [...new Set(nodes.map((r) => String(r["session"])))], rows };
	},
};
