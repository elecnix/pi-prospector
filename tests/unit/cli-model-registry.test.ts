import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPiModelRegistry, lazyModelRegistry, type PiCodingAgent } from "../../src/cli.js";
import type { PiAssistantMessage, PiContext, PiModel } from "../../src/pi-stubs.js";

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

describe("lazyModelRegistry", () => {
	const model: PiModel = { id: "m", provider: "p" };
	const context: PiContext = { messages: [] };
	const reply = { role: "assistant", content: [] } as unknown as PiAssistantMessage;

	function real(extra: object) {
		return {
			find: () => model,
			getAll: () => [],
			getAvailable: () => [],
			getApiKeyAndHeaders: async () => ({ ok: true as const }),
			...extra,
		};
	}

	it("completes through the loaded registry when pi provides streamSimple", async () => {
		const seen: unknown[] = [];
		const registry = lazyModelRegistry(async () =>
			real({
				streamSimple: (_m: PiModel, _c: PiContext, options: unknown) => {
					seen.push(options);
					return { result: async () => reply };
				},
			}),
		);
		assert.equal(await registry.streamSimple(model, context, { maxTokens: 7 }).result(), reply);
		assert.deepEqual(seen, [{ maxTokens: 7 }]);
	});

	it("loads the registry only when a lookup needs it", async () => {
		let loads = 0;
		const registry = lazyModelRegistry(async () => {
			loads++;
			return real({});
		});
		assert.equal(loads, 0);
		await registry.find("p", "m");
		assert.equal(loads, 1);
	});
});
