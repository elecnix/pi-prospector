/**
 * Deterministic decision-model double for tests: a responder maps a request to
 * its answers, and every request is recorded.
 */

import type { DecisionAnswer, DecisionCaller, DecisionRequest } from "./decision-model.js";

export interface MockDecisionModel {
	caller: DecisionCaller;
	calls: DecisionRequest[];
}

export interface MockDecisionModelOptions {
	responder: (request: DecisionRequest, index: number) => Record<string, DecisionAnswer>;
	inputTokensPerCall?: number;
	costPerCall?: number;
}

export function createMockDecisionModel(options: MockDecisionModelOptions): MockDecisionModel {
	const calls: DecisionRequest[] = [];
	const caller: DecisionCaller = async (request) => {
		const index = calls.length;
		calls.push(request);
		return {
			answers: options.responder(request, index),
			model: request.model,
			costUsd: options.costPerCall ?? 0,
			inputTokens: options.inputTokensPerCall ?? 0,
			outputTokens: 0,
			durationMs: 0,
		};
	};
	return { caller, calls };
}
