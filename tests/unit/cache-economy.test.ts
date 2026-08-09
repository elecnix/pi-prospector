/**
 * Unit tests for the cache-economy analyzer's pure measurement functions.
 * All expected numbers are hand-computed; no DB, no framework.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_CACHE_ECONOMY_CONFIG,
	type CacheEconomyConfig,
	measureCache,
	countWriteChurn,
	classifyTurn,
	buildProposals,
	type UsageRow,
} from "../../src/analyze/analyzers/cache-economy/index.js";

const cfg: CacheEconomyConfig = { ...DEFAULT_CACHE_ECONOMY_CONFIG };

function row(o: Partial<UsageRow>): UsageRow {
	return {
		role: "assistant",
		timestamp: null,
		usage: null,
		model: null,
		cost_usd: null,
		...o,
	};
}

function usage(o: Record<string, number>): string {
	return JSON.stringify(o);
}

describe("cache-economy classifyTurn", () => {
	it("classifies a healthy hit by hit-ratio", () => {
		// cacheRead 9000 / (9000 + 0 + 1000) = 0.9 → hit
		assert.equal(
			classifyTurn({ inputTokens: 1000, cacheReadTokens: 9000, cacheWriteTokens: 0, hitRatio: 0.9, gapSeconds: 5, isFirstBilled: true, cfg }),
			"hit",
		);
	});

	it("classifies an unbilled turn (no usage) as unbilled", () => {
		assert.equal(
			classifyTurn({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, hitRatio: null, gapSeconds: null, isFirstBilled: false, cfg }),
			"unbilled",
		);
	});

	it("classifies the first billed turn with a large cold input as cold-start, not a defect", () => {
		// first turn, no cache read, large fresh input → cold-start
		assert.equal(
			classifyTurn({ inputTokens: 30000, cacheReadTokens: 0, cacheWriteTokens: 0, hitRatio: 0, gapSeconds: null, isFirstBilled: true, cfg }),
			"cold-start",
		);
	});

	it("classifies a cold miss after a long gap as cold-ttl", () => {
		// non-first, large input, no read, gap > 300s TTL
		assert.equal(
			classifyTurn({ inputTokens: 30000, cacheReadTokens: 0, cacheWriteTokens: 0, hitRatio: 0, gapSeconds: 600, isFirstBilled: false, cfg }),
			"cold-ttl",
		);
	});

	it("classifies a cold miss within TTL as cold-prefix", () => {
		assert.equal(
			classifyTurn({ inputTokens: 30000, cacheReadTokens: 0, cacheWriteTokens: 0, hitRatio: 0, gapSeconds: 10, isFirstBilled: false, cfg }),
			"cold-prefix",
		);
	});

	it("does not flag a small fresh request as a cold miss", () => {
		// input below largeInputTokens → partial, not cold
		assert.equal(
			classifyTurn({ inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, hitRatio: 0, gapSeconds: 10, isFirstBilled: false, cfg }),
			"partial",
		);
	});
});

describe("cache-economy measureCache", () => {
	it("computes aggregate hit ratio and per-turn classifications", () => {
		const rows: UsageRow[] = [
			row({ role: "user" }),
			row({ role: "assistant", timestamp: "2024-01-01T00:00:00Z", usage: usage({ input: 30000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 30100 }) }),
			row({ role: "assistant", timestamp: "2024-01-01T00:01:00Z", usage: usage({ input: 1000, output: 50, cacheRead: 9000, cacheWrite: 0, totalTokens: 10050 }) }),
			row({ role: "assistant", timestamp: "2024-01-01T00:02:00Z", usage: usage({ input: 1000, output: 50, cacheRead: 9000, cacheWrite: 0, totalTokens: 10050 }) }),
		];

		const { turns, aggregate } = measureCache(rows, cfg);

		// turn 0: cold-start (first, large input, no read)
		assert.equal(turns[0]!.classification, "cold-start");
		// turn 1: hit (gap 60s, hitRatio 0.9)
		assert.equal(turns[1]!.classification, "hit");
		assert.equal(turns[1]!.gapSeconds, 60);
		// turn 2: hit
		assert.equal(turns[2]!.classification, "hit");

		// aggregate: read 18000 / (18000 + 0 + 32000) = 0.36
		assert.equal(aggregate.input, 32000);
		assert.equal(aggregate.cacheRead, 18000);
		// 18000 / 50000 = 0.36
		assert.ok(Math.abs(aggregate.aggregateHitRatio! - 0.36) < 1e-9);
	});

	it("separates a ttl cold miss from a prefix cold miss by gap", () => {
		const rows: UsageRow[] = [
			row({ role: "assistant", timestamp: "2024-01-01T00:00:00Z", usage: usage({ input: 30000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 30100 }) }),
			row({ role: "assistant", timestamp: "2024-01-01T00:06:00Z", usage: usage({ input: 30000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 30100 }) }), // gap 360 > 300 → ttl
			row({ role: "assistant", timestamp: "2024-01-01T00:06:10Z", usage: usage({ input: 30000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 30100 }) }), // gap 10 → prefix
		];
		const { turns } = measureCache(rows, cfg);
		assert.equal(turns[0]!.classification, "cold-start");
		assert.equal(turns[1]!.classification, "cold-ttl");
		assert.equal(turns[2]!.classification, "cold-prefix");
	});
});

describe("cache-economy countWriteChurn", () => {
	it("counts only writes never followed by a read", () => {
		const turns = [
			{ cacheWriteTokens: 0, cacheReadTokens: 5000 },
			{ cacheWriteTokens: 2000, cacheReadTokens: 0 }, // no read after → churn
			{ cacheWriteTokens: 1000, cacheReadTokens: 8000 }, // read after → not churn
		] as never[] as Array<{ cacheWriteTokens: number; cacheReadTokens: number }>;
		const typed = turns.map((t) => ({ cacheWriteTokens: t.cacheWriteTokens, cacheReadTokens: t.cacheReadTokens } as Parameters<typeof countWriteChurn>[0][number]));
		// last write (index 2) has no later read → 1000 churned. index 1 has a later read → not churned.
		assert.equal(countWriteChurn(typed), 1000);
	});
});

describe("cache-economy buildProposals", () => {
	function props(overrides: Partial<Parameters<typeof buildProposals>[0]>): Parameters<typeof buildProposals>[0] {
		return {
			session_id: "s",
			turns: [],
			usage_recorded_turn_count: 3,
			unbilled_turn_count: 0,
			priced_turn_count: 3,
			unpriced_turn_count: 0,
			aggregate_hit_ratio: 0.4,
			aggregate_input_tokens: 60000,
			aggregate_cache_read_tokens: 40000,
			aggregate_cache_write_tokens: 0,
			classification_counts: { hit: 0, "cold-ttl": 2, "cold-prefix": 1, "cold-start": 1, partial: 0, unbilled: 0 } as never,
			write_churn_tokens: 0,
			cold_miss_cost_usd: 0.012,
			cold_priced_turn_count: 3,
			cold_turn_count: 3,
			...overrides,
		};
	}

	it("emits cold-cache proposal above min cold turns, with dollar lower bound", () => {
		const p = buildProposals(props({}), cfg);
		assert.ok(p.some((x) => x.title.includes("Cold prompt cache")));
		const cold = p.find((x) => x.title.includes("Cold prompt cache"))!;
		assert.ok(cold.summary.includes("lower bound"), "labels dollar figure as a lower bound");
		assert.ok(cold.summary.includes("40%"), "prints aggregate hit ratio");
	});

	it("emits ttl and prefix proposals separately", () => {
		const p = buildProposals(props({ classification_counts: { hit: 0, "cold-ttl": 2, "cold-prefix": 1, "cold-start": 1, partial: 0, unbilled: 0 } as never }), cfg);
		assert.ok(p.some((x) => x.title.includes("TTL expiry")), "ttl proposal present");
		assert.ok(p.some((x) => x.title.includes("Prefix instability")), "prefix proposal present");
	});

	it("emits write-churn proposal when churn is nonzero", () => {
		const p = buildProposals(props({ write_churn_tokens: 15000 }), cfg);
		assert.ok(p.some((x) => x.title.includes("Write churn")));
	});

	it("keeps it a clean metric (no proposals) when there are no cold misses or churn", () => {
		const p = buildProposals(
			props({ cold_turn_count: 0, cold_miss_cost_usd: null, classification_counts: { hit: 3, "cold-ttl": 0, "cold-prefix": 0, "cold-start": 0, partial: 0, unbilled: 0 } as never }),
			cfg,
		);
		assert.equal(p.length, 0);
	});
});
