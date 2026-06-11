/**
 * Mock LLM caller for tests.
 *
 * Analyzers that require an LLM are exercised against this deterministic mock
 * rather than any real or local model. Two construction styles are supported:
 *
 *   - a fixed/scripted queue of responses, consumed in order; or
 *   - a responder function that maps a request to response text.
 *
 * The mock records every request it received so tests can assert on prompts,
 * models, and call counts.
 */

import type { LLMCaller, LLMRequest, LLMResponse } from "./types.js";

export interface MockLLM {
	caller: LLMCaller;
	/** All requests received, in order. */
	calls: LLMRequest[];
}

export interface MockLLMOptions {
	/** Map a request to the response text (typically JSON). */
	responder?: (request: LLMRequest, index: number) => string;
	/** Fixed sequence of response texts, consumed in order. Overrides `responder`. */
	scripted?: string[];
	/** Default text when neither responder nor scripted produces one. */
	fallback?: string;
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

		let text: string;
		if (options.scripted) {
			text = options.scripted[i] ?? options.fallback ?? "";
		} else if (options.responder) {
			text = options.responder(request, i);
		} else {
			text = options.fallback ?? "";
		}

		return {
			text,
			model: request.model,
			costUsd: options.costPerCall ?? 0,
			tokensUsed: options.tokensPerCall ?? 0,
			durationMs: 0,
			stopReason: "stop",
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
