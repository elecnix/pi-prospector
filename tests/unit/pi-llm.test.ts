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
		assert.equal(r.structured, undefined);
	});

	it("extracts tool-call arguments as structured output", () => {
		const args = { sentiment: "neutral", is_genuine_correction: false };
		const msg = assistantMessage({
			content: [{ type: "toolCall", id: "tc-1", name: "classify_turn", arguments: args }],
		});
		const r = toLLMResponse(msg, "anthropic/m", 0);
		assert.equal(r.text, "");
		assert.deepEqual(r.structured, args);
	});

	it("returns complete structured output even when the stop reason is length", () => {
		const args = { session_summary: "complete despite length" };
		const msg = assistantMessage({
			content: [{ type: "toolCall", id: "tc-1", name: "submit_session_analysis", arguments: args }],
			stopReason: "length",
			usage: { input: 100, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 600, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		});
		const r = toLLMResponse(msg, "google/gemini-2.5-flash", 0);
		assert.equal(r.stopReason, "length");
		assert.deepEqual(r.structured, args);
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

	it("parses text as JSON only when parseTextJson is true (responseSchema path)", () => {
		const msg = assistantMessage({
			content: [{ type: "text", text: '{"class":"acceptance","quote":"ok"}' }],
		});
		// Without parseTextJson: text stays as text, structured is undefined
		const r1 = toLLMResponse(msg, "anthropic/m", 0);
		assert.equal(r1.structured, undefined, "no structured without parseTextJson");
		assert.ok(r1.text.includes("acceptance"), "text preserved");

		// With parseTextJson: text is parsed into structured
		const r2 = toLLMResponse(msg, "anthropic/m", 0, true);
		assert.deepEqual(r2.structured, { class: "acceptance", quote: "ok" }, "text parsed as JSON");
	});

	it("does not parse non-JSON text even with parseTextJson", () => {
		const msg = assistantMessage({
			content: [{ type: "text", text: "I cannot classify this" }],
		});
		const r = toLLMResponse(msg, "anthropic/m", 0, true);
		assert.equal(r.structured, undefined, "non-JSON text not parsed");
		assert.equal(r.text, "I cannot classify this");
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
