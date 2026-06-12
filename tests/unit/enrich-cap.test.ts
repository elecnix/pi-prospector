import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeEnrichCap, DEFAULT_TURN_PAIR_LLM_CONFIG, type TurnPairLLMConfig } from "../../src/analyze/analyzers/turn-pair-llm/config.js";

describe("computeEnrichCap", () => {
	const defaults = DEFAULT_TURN_PAIR_LLM_CONFIG;

	it("returns the total count when it is below the ceiling with minPairFraction=1", () => {
		assert.equal(computeEnrichCap(10, defaults), 10);
		assert.equal(computeEnrichCap(1, defaults), 1);
		assert.equal(computeEnrichCap(0, defaults), 1); // minimum is 1
	});

	it("clamps to the hard ceiling when total exceeds it", () => {
		assert.equal(computeEnrichCap(80, defaults), defaults.maxPairsHardCeiling);
		assert.equal(computeEnrichCap(100, defaults), defaults.maxPairsHardCeiling);
	});

	it("returns minimum 1 even when totalHighSignal is 0", () => {
		assert.equal(computeEnrichCap(0, defaults), 1);
	});

	it("scales with a fractional minPairFraction", () => {
		const config: TurnPairLLMConfig = {
			...defaults,
			minPairFraction: 0.5,
			maxPairsHardCeiling: 50,
		};
		// 0.5 * 20 = 10
		assert.equal(computeEnrichCap(20, config), 10);
		// 0.5 * 21 rounds to 11
		assert.equal(computeEnrichCap(21, config), 11);
		// Even with 0.5 fraction, at least 1
		assert.equal(computeEnrichCap(1, config), 1);
	});

	it("rounds fraction-based cap correctly", () => {
		const config: TurnPairLLMConfig = {
			...defaults,
			minPairFraction: 0.33,
			maxPairsHardCeiling: 50,
		};
		// 0.33 * 27 ≈ 8.91 → rounds to 9
		assert.equal(computeEnrichCap(27, config), 9);
		// 0.33 * 3 ≈ 0.99 → rounds to 1 (minimum)
		assert.equal(computeEnrichCap(3, config), 1);
	});

	it("clamps minPairFraction to [0, 1]", () => {
		const over: TurnPairLLMConfig = { ...defaults, minPairFraction: 2.0 };
		assert.equal(computeEnrichCap(20, over), 20); // fraction clamped to 1.0

		const under: TurnPairLLMConfig = { ...defaults, minPairFraction: -0.5 };
		assert.equal(computeEnrichCap(20, under), 1); // fraction clamped to 0, minimum 1
	});

	it("clamps maxPairsHardCeiling to at least 1", () => {
		const bad: TurnPairLLMConfig = { ...defaults, maxPairsHardCeiling: 0 };
		assert.equal(computeEnrichCap(10, bad), 1);
		const negative: TurnPairLLMConfig = { ...defaults, maxPairsHardCeiling: -5 };
		assert.equal(computeEnrichCap(10, negative), 1);
	});

	it("returns ceiling when fraction * total exceeds ceiling", () => {
		const config: TurnPairLLMConfig = {
			...defaults,
			minPairFraction: 1.0,
			maxPairsHardCeiling: 30,
		};
		// 1.0 * 50 = 50, but ceiling is 30
		assert.equal(computeEnrichCap(50, config), 30);
	});

	it("matches the old flat cap of 20 when ceiling=20 and fraction=1 with 27 high-signal pairs", () => {
		const legacy: TurnPairLLMConfig = {
			...defaults,
			minPairFraction: 1.0,
			maxPairsHardCeiling: 20,
		};
		// 27 high-signal pairs, but hard ceiling of 20
		assert.equal(computeEnrichCap(27, legacy), 20);
	});

	it("allows all 27 high-signal pairs when ceiling is 50 and fraction is 1.0", () => {
		// This is the key improvement: previously a flat 20 would drop 7 pairs
		assert.equal(computeEnrichCap(27, defaults), 27);
	});
});