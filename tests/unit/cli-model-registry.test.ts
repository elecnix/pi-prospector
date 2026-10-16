import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPiModelRegistry, type PiCodingAgent } from "../../src/cli.js";

describe("buildPiModelRegistry", () => {
	it("loads extensions into the runtime the registry reads", async () => {
		const runtime = { providers: [] as string[] };
		const seen: unknown[] = [];
		class FakeRegistry {
			constructor(public runtime: { providers: string[] }) {}
			find(provider: string, modelId: string) {
				return this.runtime.providers.includes(provider) ? { provider, id: modelId } : undefined;
			}
			getAll() {
				return [];
			}
			getAvailable() {
				return [];
			}
			async getApiKeyAndHeaders() {
				return { ok: true as const };
			}
		}
		const pi: PiCodingAgent = {
			ModelRuntime: { create: async () => runtime },
			ModelRegistry: FakeRegistry as unknown as PiCodingAgent["ModelRegistry"],
			createAgentSessionServices: async (options) => {
				seen.push(options.modelRuntime);
				(options.modelRuntime as typeof runtime).providers.push("ollama-cloud");
				return {};
			},
		};
		const registry = await buildPiModelRegistry(pi, "/work");
		assert.equal(seen[0], runtime);
		assert.ok(registry.find("ollama-cloud", "deepseek-v4.1-flash"));
	});
});
