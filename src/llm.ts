/**
 * LLM integration for analyzer framework
 * Uses OpenRouter API with poolside/laguna-m.1:free model
 */

import type { LLMRequest, LLMResponse } from "./analyze.js";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = "poolside/laguna-m.1:free";

export async function callLLM(request: LLMRequest): Promise<LLMResponse> {
	if (!OPENROUTER_API_KEY) {
		throw new Error("OPENROUTER_API_KEY not set");
	}

	const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${OPENROUTER_API_KEY}`,
			"Content-Type": "application/json",
			"HTTP-Referer": "https://github.com/nicolas/pi-prospector",
		},
		body: JSON.stringify({
			model: request.model || MODEL,
			messages: request.messages,
			max_tokens: request.maxTokens || 1000,
			temperature: request.temperature ?? 0.3,
			response_format: request.json ? { type: "json_object" } : undefined,
		}),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`LLM call failed: ${response.status} ${error}`);
	}

	const data = await response.json();
	const choice = data.choices?.[0];
	
	return {
		content: choice?.message?.content || "",
		json: request.json ? JSON.parse(choice?.message?.content || "{}") : undefined,
		model: data.model || MODEL,
		usage: {
			inputTokens: data.usage?.prompt_tokens,
			outputTokens: data.usage?.completion_tokens,
		},
		costUsd: data.cost || 0,
	};
}

// Hook for AnalyzerFramework to inject
export function createLLMContext() {
	return { callLLM };
}
