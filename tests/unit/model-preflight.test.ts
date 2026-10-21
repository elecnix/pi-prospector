import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertModelsResolve } from "../../src/analyze/model-preflight.js";
import type { ModelRegistry } from "../../src/pi-stubs.js";

function registryWith(...known: string[]): ModelRegistry {
	return {
		find: async (provider, modelId) => (known.includes(`${provider}/${modelId}`) ? { provider, id: modelId } : undefined),
		getAll: async () => [],
		getAvailable: async () => [],
		getApiKeyAndHeaders: async () => ({ ok: true }),
	};
}

describe("assertModelsResolve", () => {
	it("passes when every model is in the registry", async () => {
		await assertModelsResolve(registryWith("a/x", "b/y"), ["a/x", "b/y", "a/x"]);
	});

	it("passes when the run uses no model", async () => {
		await assertModelsResolve(registryWith(), []);
	});

	it("names the missing model and the pi form that loads extensions", async () => {
		await assert.rejects(
			assertModelsResolve(registryWith("a/x"), ["a/x", "ollama-cloud/deepseek-v4.1-flash"]),
			(err: Error) => {
				assert.match(err.message, /ollama-cloud\/deepseek-v4\.1-flash/);
				assert.match(err.message, /pi -e .* --prospect/);
				assert.doesNotMatch(err.message, /a\/x/);
				return true;
			},
		);
	});
});

describe("assertModelsResolve with a decision model", () => {
	it("leaves decision-model identities to the decision client", async () => {
		await assertModelsResolve(registryWith("a/x"), ["a/x", "decision:jev/jev-1.13.0#abc"]);
	});
});
