/**
 * Unit tests for the tool-inventory-tax pure functions (issue #70): the set
 * difference against the inventory, and the per-turn implied-rate pricing.
 * Pure functions, no database, no LLM.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	collectInvokedToolNames,
	computeUnusedTools,
	estimateTax,
	parseToolInventory,
	type InventoryTool,
	type TurnBilling,
} from "../../src/analyze/analyzers/tool-inventory-tax/index.js";

// ─────────────────────────── parseToolInventory ───────────────────────────

describe("parseToolInventory", () => {
	it("parses a populated manifest with sizing", () => {
		const inv = parseToolInventory(
			JSON.stringify({
				source: "pi-session-header",
				tools: [
					{ name: "read", definitionChars: 350 },
					{ name: "bash", definitionChars: null },
				],
			}),
		);
		assert.equal(inv.source, "pi-session-header");
		assert.deepEqual(inv.tools, [
			{ name: "read", definitionChars: 350 },
			{ name: "bash", definitionChars: null },
		]);
	});

	it("rejects a blob without a tools array", () => {
		assert.throws(() => parseToolInventory('{"source":"x"}'), /tools array/);
	});

	it("rejects an entry without a name", () => {
		assert.throws(() => parseToolInventory('{"source":"x","tools":[{"definitionChars":1}]}'), /name/);
	});
});

// ─────────────────────────── collectInvokedToolNames ───────────────────────────

describe("collectInvokedToolNames", () => {
	it("collects distinct names across rows and skips non-string entries", () => {
		const invoked = collectInvokedToolNames([
			{ tool_calls: JSON.stringify([{ name: "read" }, { name: "bash" }]) },
			{ tool_calls: null },
			{ tool_calls: JSON.stringify([{ name: "read" }, {}]) },
			{ tool_calls: JSON.stringify([]) },
		]);
		assert.deepEqual([...invoked].sort(), ["bash", "read"]);
	});
});

// ─────────────────────────── computeUnusedTools ───────────────────────────

describe("computeUnusedTools", () => {
	it("returns the set difference with aggregate sizing", () => {
		const tools: InventoryTool[] = [
			{ name: "read", definitionChars: 100 },
			{ name: "edit", definitionChars: 250 },
			{ name: "mcp-a.search", definitionChars: 4000 },
			{ name: "mcp-b.render", definitionChars: null },
		];
		const { unused, definitionChars, unsizedCount } = computeUnusedTools(tools, new Set(["read", "edit"]));
		assert.deepEqual(unused.map((t) => t.name).sort(), ["mcp-a.search", "mcp-b.render"]);
		assert.equal(definitionChars, 4000, "unsized tools contribute no chars");
		assert.equal(unsizedCount, 1, "unsized tools stay counted");
	});

	it("is empty when every available tool was invoked", () => {
		const tools: InventoryTool[] = [{ name: "read", definitionChars: 10 }];
		const r = computeUnusedTools(tools, new Set(["read"]));
		assert.equal(r.unused.length, 0);
		assert.equal(r.definitionChars, 0);
	});
});

// ─────────────────────────── estimateTax ───────────────────────────

describe("estimateTax", () => {
	it("prices rebuild turns at the blended input+cacheWrite rate and carry turns at the cacheRead rate", () => {
		// prefixTokens = 1000
		const turns: TurnBilling[] = [
			// Rebuild turn (cacheRead == 0): rate = 0.003 / 1500 = 2e-6/token → 1000 × 2e-6 = 0.002
			{ input: 1000, cacheRead: 0, cacheWrite: 500, cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0.002 } },
			// Carry turn: rate = 0.005 / 100_000 = 5e-8/token → 1000 × 5e-8 = 0.00005
			{ input: 50, cacheRead: 100_000, cacheWrite: 0, cost: { input: 0.001, output: 0, cacheRead: 0.005, cacheWrite: 0 } },
			// Another carry turn at a different price: rate = 0.01 / 200_000 = 5e-8 → 0.00005
			{ input: 0, cacheRead: 200_000, cacheWrite: 20, cost: { input: 0, output: 0, cacheRead: 0.01, cacheWrite: 0 } },
		];
		const est = estimateTax(1000, turns);
		assert.equal(est.pricedTurns, 3);
		assert.equal(est.unpricedTurns, 0);
		assert.equal(est.method, "per-turn-implied-rates");
		// 0.002 + 0.00005 + 0.00005 = 0.0021
		assert.equal(est.taxUsd, 0.0021);
	});

	it("counts unpriced turns instead of silently zero-pricing them", () => {
		const turns: TurnBilling[] = [
			{ input: 1000, cacheRead: 0, cacheWrite: 0, cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0 } },
			{ input: 50, cacheRead: 90_000, cacheWrite: 0, cost: null }, // Claude Code records none
		];
		const est = estimateTax(1000, turns);
		assert.equal(est.pricedTurns, 1);
		assert.equal(est.unpricedTurns, 1, "the cost-less turn is excluded, not zero-priced");
		assert.ok(est.taxUsd !== null && est.taxUsd > 0);
	});

	it("falls back to token-turns-only when no turn carries any cost breakdown", () => {
		const turns: TurnBilling[] = [
			{ input: 1000, cacheRead: 0, cacheWrite: 0, cost: null },
			{ input: 0, cacheRead: 80_000, cacheWrite: 0, cost: null },
		];
		const est = estimateTax(1000, turns);
		assert.equal(est.taxUsd, null, "no synthetic dollars");
		assert.equal(est.method, "token-turns-only");
		assert.equal(est.unpricedTurns, 2);
	});

	it("treats zero-cost rebuild denominators as unpriced", () => {
		const est = estimateTax(1000, [{ input: 0, cacheRead: 0, cacheWrite: 0, cost: null }]);
		assert.equal(est.method, "token-turns-only");
		assert.equal(est.taxUsd, null);
	});

	it("a reported zero cacheRead cost prices honestly at zero", () => {
		const est = estimateTax(1000, [
			{ input: 10, cacheRead: 80_000, cacheWrite: 0, cost: { input: 0.0001, output: 0, cacheRead: 0, cacheWrite: 0 } },
		]);
		assert.equal(est.taxUsd, 0, "a provider that genuinely reports $0 cacheRead is not 'unpriced'");
		assert.equal(est.method, "per-turn-implied-rates");
	});
});
