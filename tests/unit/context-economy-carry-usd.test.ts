/**
 * Unit tests for context-economy's dollar carry pricing (issue #78).
 * Pure functions; hand-computed; no DB, no framework.
 *
 * Carry is re-priced at each turn's own implied rate from the per-bucket
 * billed dollars (#65): cacheRead $/token on a carry turn, blended
 * (input + cacheWrite) $/token on a rebuild turn inside the window. A turn
 * without a per-bucket breakdown is excluded and counted — never zero-priced.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	isPricedTurn,
	parseCarryBilling,
	priceCarry,
	turnImpliedRate,
	type CarryTurnBilling,
} from "../../src/analyze/analyzers/context-economy/index.js";

/** Shorthand builder: token buckets plus an optional per-bucket cost breakdown. */
function turn(input: number, cacheRead: number, cacheWrite: number, cost: CarryTurnBilling["cost"]): CarryTurnBilling {
	return { inputTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, cost };
}

describe("context-economy isPricedTurn", () => {
	it("a turn with a breakdown and a cacheRead denominator is priced", () => {
		assert.equal(isPricedTurn(turn(100, 1000, 0, { input: 0, output: 0, cacheRead: 0.003, cacheWrite: 0 })), true);
	});

	it("a rebuild turn (cacheRead == 0) is priced via input + cacheWrite", () => {
		assert.equal(isPricedTurn(turn(500, 0, 500, { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0.002 })), true);
	});

	it("a turn without any breakdown is unpriced — UNKNOWN cost, not zero", () => {
		assert.equal(isPricedTurn(turn(100, 1000, 0, null)), false);
	});

	it("a breakdown with no usable denominator is unpriced", () => {
		assert.equal(isPricedTurn(turn(0, 0, 0, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })), false);
	});
});

describe("context-economy turnImpliedRate", () => {
	it("prices a carry turn at its cacheRead $/token", () => {
		const t = turn(100, 1000, 0, { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0 });
		assert.equal(turnImpliedRate(t), 0.003 / 1000);
	});

	it("prices a rebuild turn at blended (input + cacheWrite) $/token", () => {
		const t = turn(500, 0, 500, { input: 0.001, output: 9, cacheWrite: 0.004 });
		assert.equal(turnImpliedRate(t), (0.001 + 0.004) / 1000);
	});

	it("returns null for an unpriced turn", () => {
		assert.equal(turnImpliedRate(turn(100, 1000, 0, null)), null);
	});
});

describe("context-economy priceCarry", () => {
	it("sums the result's own share of each carry turn's cacheRead dollars (hand-computed)", () => {
		const usd = priceCarry(10_000, [
			turn(100, 1_000_000, 0, { input: 0, output: 0, cacheRead: 3, cacheWrite: 0 }),
			turn(100, 2_000_000, 0, { input: 0, output: 0, cacheRead: 4, cacheWrite: 0 }),
		]);
		// 10_000 × (3/1_000_000) + 10_000 × (4/2_000_000) = 0.03 + 0.02
		assert.equal(usd.carryUsd, 0.05);
		assert.equal(usd.pricedTurns, 2);
		assert.equal(usd.unpricedTurns, 0);
	});

	it("excludes and counts turns lacking a per-bucket breakdown instead of zero-pricing them", () => {
		const usd = priceCarry(10_000, [
			turn(100, 1_000_000, 0, { input: 0, output: 0, cacheRead: 3, cacheWrite: 0 }),
			turn(100, 900_000, 0, null),
		]);
		// Only the first turn contributes: 10_000 × 0.000003 = 0.03.
		assert.equal(usd.carryUsd, 0.03);
		assert.equal(usd.pricedTurns, 1);
		assert.equal(usd.unpricedTurns, 1);
	});

	it("null when no turn in the window could be priced", () => {
		const usd = priceCarry(10_000, [turn(100, 1_000_000, 0, null)]);
		assert.equal(usd.carryUsd, null);
		assert.equal(usd.pricedTurns, 0);
		assert.equal(usd.unpricedTurns, 1);
	});

	it("an empty window prices to null with nothing counted", () => {
		assert.deepEqual(priceCarry(10_000, []), { carryUsd: null, pricedTurns: 0, unpricedTurns: 0 });
	});

	it("a rebuild turn inside the window is priced at blended rate, not skipped", () => {
		const usd = priceCarry(5_000, [
			turn(400, 0, 600, { input: 0.002, output: 0, cacheRead: 0, cacheWrite: 0.003 }),
		]);
		// 5_000 × ((0.002 + 0.003) / 1_000) = 5_000 × 0.000005 = 0.025
		assert.equal(usd.carryUsd, 0.025);
		assert.equal(usd.pricedTurns, 1);
	});

	it("rounds to six decimals like the tool-inventory-tax estimate", () => {
		const usd = priceCarry(1, [
			turn(3, 1, 0, { input: 0, output: 0, cacheRead: 1 / 3, cacheWrite: 0 }),
		]);
		assert.equal(usd.carryUsd, Math.round((1 / 3) * 1e6) / 1e6);
	});
});

describe("context-economy parseCarryBilling", () => {
	const row = (role: string, usage: string | null) => ({ role, tool_calls: null as string | null, tool_results: null as string | null, usage });

	it("reads the per-bucket cost nested inside the stored usage blob", () => {
		const b = parseCarryBilling(row("assistant", JSON.stringify({
			input: 1200, output: 50, cacheRead: 90_000, cacheWrite: 300,
			totalTokens: 91_550,
			cost: { input: 0.001, output: 0.0002, cacheRead: 0.27, cacheWrite: 0.004, total: 0.2752 },
		})));
		assert.ok(b, "assistant row with usage parses");
		assert.deepEqual(b, {
			inputTokens: 1200,
			cacheReadTokens: 90_000,
			cacheWriteTokens: 300,
			cost: { input: 0.001, output: 0.0002, cacheRead: 0.27, cacheWrite: 0.004 },
		});
	});

	it("cost stays null when the host reported none — never zero", () => {
		const b = parseCarryBilling(row("assistant", JSON.stringify({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 })));
		assert.ok(b, "assistant row with usage parses");
		assert.equal(b.cost, null);
		assert.equal(b.inputTokens, 1);
		assert.equal(b.cacheReadTokens, 3);
	});

	it("non-assistant rows and rows without usage are not billing inputs", () => {
		assert.equal(parseCarryBilling(row("user", JSON.stringify({ cost: {} }))), null);
		assert.equal(parseCarryBilling(row("assistant", null)), null);
		assert.equal(parseCarryBilling(row("toolResult", "{}")), null);
	});
});
