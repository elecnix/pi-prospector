import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODEL_TIERS, applyModelOverride, isModelTier, resolveModelSpec, splitModelSpec } from "../../src/analyze/model-tiers.js";

describe("model tiers", () => {
	it("recognises tier names", () => {
		assert.ok(isModelTier("cheap"));
		assert.ok(isModelTier("mid"));
		assert.ok(isModelTier("expensive"));
		assert.ok(!isModelTier("anthropic/x"));
	});

	it("resolves tiers via config", () => {
		const cfg = { cheap: "p/c", mid: "p/m", expensive: "p/e" };
		assert.equal(resolveModelSpec("cheap", cfg), "p/c");
		assert.equal(resolveModelSpec("mid", cfg), "p/m");
	});

	it("resolves tiers via defaults when no config", () => {
		assert.equal(resolveModelSpec("mid"), DEFAULT_MODEL_TIERS.mid);
	});

	it("passes through explicit provider/model specs", () => {
		assert.equal(resolveModelSpec("openai/gpt-5"), "openai/gpt-5");
	});

	it("splits provider/model, preserving slashes in model id", () => {
		assert.deepEqual(splitModelSpec("anthropic/claude-sonnet-4-5"), { provider: "anthropic", modelId: "claude-sonnet-4-5" });
		assert.deepEqual(splitModelSpec("vertex/google/gemini"), { provider: "vertex", modelId: "google/gemini" });
	});

	it("throws on a spec without a slash", () => {
		assert.throws(() => splitModelSpec("nope"), /Invalid model spec/);
	});

	describe("applyModelOverride", () => {
		const tiers = { cheap: "p/c", mid: "p/m", expensive: "p/e" };

		it("returns the tiers unchanged when there is no override", () => {
			assert.equal(applyModelOverride(tiers, undefined), tiers);
			assert.equal(applyModelOverride(tiers, ""), tiers);
		});

		it("pins every tier to an explicit provider/model override", () => {
			assert.deepEqual(applyModelOverride(tiers, "openai/gpt-5"), {
				cheap: "openai/gpt-5",
				mid: "openai/gpt-5",
				expensive: "openai/gpt-5",
			});
		});

		it("resolves a tier-name override through the tiers, then pins all tiers", () => {
			assert.deepEqual(applyModelOverride(tiers, "expensive"), {
				cheap: "p/e",
				mid: "p/e",
				expensive: "p/e",
			});
		});
	});
});
