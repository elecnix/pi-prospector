/**
 * Mock LLM caller for tests.
 *
 * Analyzers that require an LLM are exercised against this deterministic mock
 * rather than any real or local model. Two construction styles are supported:
 *
 *   - a fixed/scripted queue of responses, consumed in order; or
 *   - a responder function that maps a request to a mock reply.
 *
 * Replies may be legacy text strings, or partial response objects with
 * `structured` arguments for tests that need to exercise forced-tool-call output.
 * The mock records every request it received so tests can assert on prompts,
 * models, tools, and call counts.
 */

import { Type, type Static } from "typebox";
import type { LLMCaller, LLMRequest, LLMResponse } from "./types.js";

export interface MockLLM {
	caller: LLMCaller;
	/** All requests received, in order. */
	calls: LLMRequest[];
}

/** A scripted mock reply: either legacy text or a partial structured LLM response. */
export const MockLLMReplySchema = Type.Union([
	Type.String(),
	Type.Object({
		text: Type.Optional(Type.String()),
		thinking: Type.Optional(Type.String()),
		structured: Type.Optional(Type.Unknown()),
		model: Type.Optional(Type.String()),
		costUsd: Type.Optional(Type.Number()),
		tokensUsed: Type.Optional(Type.Number()),
		durationMs: Type.Optional(Type.Number()),
		stopReason: Type.Optional(Type.String()),
	}),
]);
export type MockLLMReply = Static<typeof MockLLMReplySchema>;

export interface MockLLMOptions {
	/** Map a request to a mock reply. Returning a string preserves the legacy text-only behaviour. */
	responder?: (request: LLMRequest, index: number) => MockLLMReply;
	/** Fixed sequence of mock replies, consumed in order. Overrides `responder`. */
	scripted?: MockLLMReply[];
	/** Default reply when neither responder nor scripted produces one. */
	fallback?: MockLLMReply;
	/** Simulated per-call token usage. */
	tokensPerCall?: number;
	/** Simulated per-call cost. */
	costPerCall?: number;
}

export function createMockLLM(options: MockLLMOptions = {}): MockLLM {
	const calls: LLMRequest[] = [];
	let index = 0;

	const caller: LLMCaller = async (request: LLMRequest): Promise<LLMResponse> => {
		const i = index++;
		calls.push(request);

		let reply: MockLLMReply;
		if (options.scripted) {
			reply = options.scripted[i] ?? options.fallback ?? "";
		} else if (options.responder) {
			reply = options.responder(request, i);
		} else {
			reply = options.fallback ?? "";
		}

		const response: Exclude<MockLLMReply, string> = typeof reply === "string" ? { text: reply } : reply;

		return {
			text: response.text ?? "",
			thinking: response.thinking,
			structured: request.tool ? response.structured : undefined,
			model: response.model ?? request.model,
			costUsd: response.costUsd ?? options.costPerCall ?? 0,
			tokensUsed: response.tokensUsed ?? options.tokensPerCall ?? 0,
			durationMs: response.durationMs ?? 0,
			stopReason: response.stopReason ?? "stop",
		};
	};

	return { caller, calls };
}

/** A mock that always throws — useful to prove deterministic analyzers never call the LLM. */
export function createThrowingLLM(message = "LLM must not be called"): LLMCaller {
	return async () => {
		throw new Error(message);
	};
}
