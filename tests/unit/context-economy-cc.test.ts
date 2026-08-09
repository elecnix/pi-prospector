/**
 * Unit tests for context-economy's compaction-policy judgment (issue #67).
 * Hand-computed; no DB, no framework.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	analyzeCompactionPolicy,
	DEFAULT_CONTEXT_ECONOMY_CONFIG,
	type ContextEconomyConfig,
} from "../../src/analyze/analyzers/context-economy/index.js";

const cfg: ContextEconomyConfig = { ...DEFAULT_CONTEXT_ECONOMY_CONFIG };

type Row = { role: string; usage: string | null };

function billed(usage: Record<string, number>): Row {
	return { role: "assistant", usage: JSON.stringify(usage) };
}
function user(): Row {
	return { role: "user", usage: null };
}
function compaction(): Row {
	return { role: "compaction", usage: null };
}

describe("context-economy analyzeCompactionPolicy", () => {
	it("flags a long held cycle as fired-too-late, with carry-avoided as a lower bound", () => {
		// 5 billed turns holding a growing carried prefix, then a flush.
		const rows: Row[] = [
			user(),
			billed({ input: 100, output: 10, cacheRead: 400000, cacheWrite: 0 }),
			billed({ input: 100, output: 10, cacheRead: 500000, cacheWrite: 0 }),
			billed({ input: 100, output: 10, cacheRead: 600000, cacheWrite: 0 }),
			billed({ input: 100, output: 10, cacheRead: 700000, cacheWrite: 0 }),
			billed({ input: 100, output: 10, cacheRead: 700000, cacheWrite: 0 }),
			compaction(),
			billed({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }), // small rebuild
		];
		const results = [
			{ ordinal: 1, carry: 1_000_000 },
			{ ordinal: 2, carry: 1_500_000 },
		];

		const p = analyzeCompactionPolicy(rows, results, cfg, 3.5);
		assert.equal(p.compactionCount, 1);
		assert.equal(p.cycles.length, 1);
		assert.equal(p.cycles[0]!.turnsSpanned, 5);
		assert.equal(p.cycles[0]!.peakCarriedTokens, 700000);
		assert.equal(p.cycles[0]!.carryAvoidedTokenTurns, 2_500_000, "sum of in-cycle carries");
		assert.equal(p.cycles[0]!.firedTooLate, true);
		assert.equal(p.cycles[0]!.firedTooOften, false);
		assert.equal(p.firedTooLateCount, 1);
		assert.equal(p.totalCarryAvoidedTokenTurns, 2_500_000);
		assert.equal(p.neverCompacted, false);
	});

	it("flags a near-empty but expensive flush as fired-too-often", () => {
		// One tiny billed turn (carried 100), then a flush that costs a huge rebuild.
		const rows: Row[] = [
			user(),
			billed({ input: 100, output: 10, cacheRead: 100, cacheWrite: 0 }),
			compaction(),
			billed({ input: 60000, output: 10, cacheRead: 0, cacheWrite: 60000 }), // rebuild 120000
		];
		const results: Array<{ ordinal: number; carry: number }> = [];

		const p = analyzeCompactionPolicy(rows, results, cfg, 3.5);
		assert.equal(p.cycles.length, 1);
		assert.equal(p.cycles[0]!.turnsSpanned, 1);
		assert.equal(p.cycles[0]!.peakCarriedTokens, 100);
		assert.equal(p.cycles[0]!.rebuildTokens, 120000);
		assert.equal(p.cycles[0]!.firedTooOften, true);
		assert.equal(p.cycles[0]!.firedTooLate, false);
		assert.equal(p.firedTooOftenCount, 1);
		assert.equal(p.totalRebuildTokens, 120000);
	});

	it("marks a high-carry session with zero compactions as never-compacted", () => {
		// No compaction events; one huge carry.
		const rows: Row[] = [
			user(),
			billed({ input: 100, output: 10, cacheRead: 5000000, cacheWrite: 0 }),
			billed({ input: 100, output: 10, cacheRead: 6000000, cacheWrite: 0 }),
		];
		const results = [{ ordinal: 1, carry: 6_000_000 }];
		const p = analyzeCompactionPolicy(rows, results, cfg, 3.5);
		assert.equal(p.compactionCount, 0);
		assert.equal(p.cycles.length, 0);
		assert.equal(p.firedTooLateCount, 0);
		assert.equal(p.neverCompacted, true, "6.0e6 carry ≥ 5e6 threshold with no compaction");
	});
});
