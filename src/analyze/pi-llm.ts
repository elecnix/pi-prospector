/**
 * Production LLM caller, wired to Pi's AI provider system.
 *
 * The flow is entirely within Pi's own provider machinery — there is no direct
 * provider SDK use and no local model server:
 *
 *   1. Resolve the requested tier/spec to a `provider/model` pair.
 *   2. `ctx.modelRegistry.find(provider, modelId)` → the Pi `Model`.
 *   3. `ctx.modelRegistry.getApiKeyAndHeaders(model)` → credentials Pi has
 *      configured for that provider (env, models.json, OAuth, …).
 *   4. `complete(model, context, { apiKey, headers, … })` from
 *      `@earendil-works/pi-ai` runs the request through Pi's provider adapters.
 *
 * `@earendil-works/pi-ai` is an optional peer dependency, so it is loaded with a
 * runtime dynamic import; tests never reach this path (they use the mock caller).
 */

import type { LLMCaller, LLMRequest, LLMResponse, ModelTierConfig } from "./types.js";
import { resolveModelSpec, splitModelSpec } from "./model-tiers.js";
import type {
	ExtensionContext,
	PiAiModule,
	PiAssistantMessage,
	PiContext,
} from "../pi-stubs.js";

let cachedModule: Promise<PiAiModule> | null = null;

/** Lazily load pi-ai via a non-literal specifier so tsc/CI don't require it. */
function loadPiAi(): Promise<PiAiModule> {
	if (!cachedModule) {
		const specifier = "@earendil-works/pi-ai";
		cachedModule = import(specifier).then((mod) => mod as unknown as PiAiModule);
	}
	return cachedModule;
}

export interface PiLLMCallerOptions {
	modelTiers: ModelTierConfig;
}

/**
 * Build an `LLMCaller` bound to a Pi extension context. The returned function
 * resolves models against the live model registry and runs completions through
 * pi-ai. Analyzers pass an already-resolved `provider/model` spec; a bare tier
 * name is still tolerated and mapped through `modelTiers` as a safety net.
 */
export function makePiLLMCaller(ctx: ExtensionContext, opts: PiLLMCallerOptions): LLMCaller {
	return async (request: LLMRequest): Promise<LLMResponse> => {
		const start = Date.now();
		const spec = resolveModelSpec(request.model || "mid", opts.modelTiers);
		const { provider, modelId } = splitModelSpec(spec);

		const model = ctx.modelRegistry.find(provider, modelId);
		if (!model) {
			throw new Error(`Model not found in Pi registry: ${provider}/${modelId}. Configure it via Pi or set modelTiers in prospector.json.`);
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			throw new Error(`No credentials for ${provider}/${modelId}: ${auth.error}`);
		}

		const piAi = await loadPiAi();
		const context: PiContext = {
			systemPrompt: request.system,
			messages: [{ role: "user", content: request.user, timestamp: Date.now() }],
		};
		if (request.tool) {
			context.tools = [
				{ name: request.tool.name, description: request.tool.description, parameters: request.tool.parameters },
			];
		}

		const message = await piAi.complete(model, context, {
			apiKey: auth.apiKey,
			headers: auth.headers,
			temperature: request.temperature,
			maxTokens: request.maxTokens,
			// Let pi-ai ride out transient rate limits (e.g. provider 429s) instead
			// of failing a whole analysis run on the first throttled call.
			maxRetries: 4,
			signal: ctx.signal,
		});

		return toLLMResponse(message, spec, Date.now() - start);
	};
}

/** Flatten a pi-ai AssistantMessage into the framework's LLMResponse. */
export function toLLMResponse(message: PiAssistantMessage, modelSpec: string, durationMs: number): LLMResponse {
	const textParts: string[] = [];
	const thinkingParts: string[] = [];
	let structured: Record<string, unknown> | undefined;
	for (const part of message.content) {
		if (part.type === "text") textParts.push(part.text);
		else if (part.type === "thinking") thinkingParts.push(part.thinking);
		else if (part.type === "toolCall" && structured === undefined) structured = part.arguments;
	}

	if (message.stopReason === "error") {
		throw new Error(`LLM error from ${modelSpec}: ${message.errorMessage ?? "unknown error"}`);
	}



	// Every call this caller makes expects a complete structured (JSON) answer, so
	// a response cut off at the output limit is never usable. Fail fast with an
	// actionable message instead of letting the truncated body surface later as a
	// cryptic "Unterminated JSON object" parse error. Reasoning models are the
	// usual cause: their thinking tokens consume the maxTokens budget. A complete
	// tool call is still usable even if the stream then reports "length".
	if (message.stopReason === "length" && structured === undefined) {
		const outputTokens = message.usage?.output ?? 0;
		throw new Error(
			`LLM response from ${modelSpec} was truncated at the output limit (${outputTokens} output tokens) ` +
				`before the answer was complete. Raise maxTokens, or use a non-reasoning model/tier for structured output.`,
		);
	}

	return {
		text: textParts.join("\n").trim(),
		thinking: thinkingParts.length > 0 ? thinkingParts.join("\n").trim() : undefined,
		structured,
		model: message.model || modelSpec,
		costUsd: message.usage?.cost?.total ?? 0,
		tokensUsed: message.usage?.totalTokens ?? 0,
		durationMs,
		stopReason: message.stopReason,
	};
}
