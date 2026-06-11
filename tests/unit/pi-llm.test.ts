import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makePiLLMCaller, toLLMResponse } from "../../src/analyze/pi-llm.js";
import type { ExtensionContext, PiAssistantMessage, PiModel, ResolvedRequestAuth } from "../../src/pi-stubs.js";

const TIERS = { cheap: "anthropic/c", mid: "anthropic/m", expensive: "anthropic/e" };

function assistantMessage(partial: Partial<PiAssistantMessage>): PiAssistantMessage {
	return {
		role: "assistant",
		content: partial.content ?? [],
		model: partial.model ?? "anthropic/m",
		usage: partial.usage ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: partial.stopReason ?? "stop",
		errorMessage: partial.errorMessage,
		timestamp: 0,
	};
}

function ctxWith(find: (p: string, m: string) => PiModel | undefined, auth: ResolvedRequestAuth): ExtensionContext {
	return {
		modelRegistry: {
			find,
			getAll: () => [],
			getAvailable: () => [],
			getApiKeyAndHeaders: async () => auth,
		},
	};
}

describe("toLLMResponse", () => {
	it("joins text parts and extracts thinking", () => {
		const msg = assistantMessage({
			content: [
				{ type: "thinking", thinking: "pondering" },
				{ type: "text", text: "hello" },
				{ type: "text", text: "world" },
			],
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 } },
		});
		const r = toLLMResponse(msg, "anthropic/m", 123);
		assert.equal(r.text, "hello\nworld");
		assert.equal(r.thinking, "pondering");
		assert.equal(r.tokensUsed, 15);
		assert.equal(r.costUsd, 0.02);
		assert.equal(r.durationMs, 123);
	});

	it("omits thinking when none present", () => {
		const r = toLLMResponse(assistantMessage({ content: [{ type: "text", text: "x" }] }), "m", 0);
		assert.equal(r.thinking, undefined);
	});

	it("throws on error stop reason", () => {
		const msg = assistantMessage({ stopReason: "error", errorMessage: "boom" });
		assert.throws(() => toLLMResponse(msg, "m", 0), /boom/);
	});

	it("throws an actionable error when the response is truncated at the output limit", () => {
		const msg = assistantMessage({
			content: [{ type: "text", text: '{"sentiment":"frus' }],
			stopReason: "length",
			usage: { input: 100, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 600, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		});
		assert.throws(() => toLLMResponse(msg, "google/gemini-2.5-flash", 0), /truncated at the output limit \(500 output tokens\)/);
	});
});

describe("makePiLLMCaller", () => {
	it("throws when the model is not in the registry", async () => {
		const caller = makePiLLMCaller(ctxWith(() => undefined, { ok: true }), { modelTiers: TIERS });
		await assert.rejects(() => caller({ model: "cheap", user: "hi" }), /Model not found/);
	});

	it("throws when credentials are unavailable", async () => {
		const caller = makePiLLMCaller(
			ctxWith(() => ({ id: "c", provider: "anthropic" }), { ok: false, error: "no key" }),
			{ modelTiers: TIERS },
		);
		await assert.rejects(() => caller({ model: "cheap", user: "hi" }), /No credentials/);
	});
});
