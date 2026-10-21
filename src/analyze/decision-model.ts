/**
 * Decision-model client (#338): the seam through which an analyzer reaches a
 * decision model such as Jev, next to the LLM caller.
 *
 * A decision model reads one `state` and answers every question in the request
 * independently, with a probability distribution over the answers the question
 * defines. It generates no text, so a classifier that only fills a fixed-choice
 * form needs one request per input instead of one generation per field.
 *
 * A model spec is `provider/model`, like an LLM spec. The provider names an
 * endpoint that speaks the System One protocol (`POST /v1/systemone`); `jev` is
 * TypeSafe's own and is always known. `decisionProviders` in prospector.json
 * adds others, or points `jev` somewhere else.
 */

import { Type, type Static } from "typebox";
import { splitModelSpec } from "./model-tiers.js";

// ─────────────────────────── questions ───────────────────────────

/** Instructions and criteria accept a string, an object, or an array (System One API). */
const Structured = Type.Union([Type.String(), Type.Record(Type.String(), Type.Unknown()), Type.Array(Type.Unknown())]);

export const NoulQuestion = Type.Object({
	type: Type.Literal("noul"),
	instructions: Structured,
	criteria: Type.Optional(Type.Object({ true: Type.Optional(Structured), false: Type.Optional(Structured) })),
});
export type NoulQuestion = Static<typeof NoulQuestion>;

export const ChoiceQuestion = Type.Object({
	type: Type.Literal("choice"),
	instructions: Structured,
	/** Option name → when it applies. */
	criteria: Type.Record(Type.String(), Structured),
});
export type ChoiceQuestion = Static<typeof ChoiceQuestion>;

export const ScoreQuestion = Type.Object({
	type: Type.Literal("score"),
	instructions: Structured,
	/** Levels from low to high; a level's position is its score. */
	criteria: Type.Array(Structured),
});
export type ScoreQuestion = Static<typeof ScoreQuestion>;

export const DecisionQuestion = Type.Union([NoulQuestion, ChoiceQuestion, ScoreQuestion]);
export type DecisionQuestion = Static<typeof DecisionQuestion>;

// ─────────────────────────── answers ───────────────────────────

export const NoulAnswer = Type.Object({ type: Type.Literal("noul"), noul: Type.Number() });
export type NoulAnswer = Static<typeof NoulAnswer>;

export const ChoiceAnswer = Type.Object({
	type: Type.Literal("choice"),
	choice: Type.String(),
	confidence: Type.Number(),
	probabilities: Type.Record(Type.String(), Type.Number()),
});
export type ChoiceAnswer = Static<typeof ChoiceAnswer>;

export const ScoreAnswer = Type.Object({
	type: Type.Literal("score"),
	score: Type.Number(),
	confidence: Type.Number(),
	/** Level index (as a string key) → probability. */
	probabilities: Type.Record(Type.String(), Type.Number()),
});
export type ScoreAnswer = Static<typeof ScoreAnswer>;

export const DecisionAnswer = Type.Union([NoulAnswer, ChoiceAnswer, ScoreAnswer]);
export type DecisionAnswer = Static<typeof DecisionAnswer>;

// ─────────────────────────── request / response ───────────────────────────

export const DecisionRequest = Type.Object({
	/** `provider/model`, e.g. `jev/jev-1.13.0`. */
	model: Type.String(),
	state: Type.Unknown(),
	questions: Type.Record(Type.String(), DecisionQuestion),
});
export type DecisionRequest = Static<typeof DecisionRequest>;

export const DecisionResponse = Type.Object({
	answers: Type.Record(Type.String(), DecisionAnswer),
	/** The model that answered, as the provider names it. */
	model: Type.String(),
	costUsd: Type.Number(),
	inputTokens: Type.Number(),
	outputTokens: Type.Number(),
	durationMs: Type.Number(),
});
export type DecisionResponse = Static<typeof DecisionResponse>;

/** The decision-model calling contract. A function type, not a data shape. */
export type DecisionCaller = (request: DecisionRequest) => Promise<DecisionResponse>;

// ─────────────────────────── providers ───────────────────────────

export const DecisionProvider = Type.Object({
	/** Base URL; the client posts to `${baseUrl}/v1/systemone`. */
	baseUrl: Type.String(),
	/** Environment variables holding the API key, first set one wins. */
	apiKeyEnv: Type.Array(Type.String()),
	/** Dollars per million input tokens, for the node's cost. Output is free on Jev. */
	inputUsdPerMtok: Type.Number(),
	outputUsdPerMtok: Type.Optional(Type.Number()),
});
export type DecisionProvider = Static<typeof DecisionProvider>;

/** TypeSafe's endpoint. Jev 1.13 and 1.14 cost $0.042 per million input tokens. */
export const DEFAULT_DECISION_PROVIDERS: Record<string, DecisionProvider> = {
	jev: {
		baseUrl: "https://api.typesafe.ai",
		apiKeyEnv: ["JEV_API_KEY", "TYPESAFE_API_KEY"],
		inputUsdPerMtok: 0.042,
	},
};

/** An HTTP failure from a decision provider, carrying its status for the retry layer. */
export class DecisionModelError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "DecisionModelError";
	}
}

export interface DecisionCallerOptions {
	providers?: Record<string, DecisionProvider>;
	env?: Record<string, string | undefined>;
	fetch?: typeof fetch;
	signal?: AbortSignal;
}

/**
 * A decision caller that posts System One requests over HTTP. The key is read
 * from the environment on each call and only ever placed in the Authorization
 * header; no error message carries it.
 */
export function makeDecisionCaller(opts: DecisionCallerOptions = {}): DecisionCaller {
	const providers = { ...DEFAULT_DECISION_PROVIDERS, ...opts.providers };
	const env = opts.env ?? process.env;
	const doFetch = opts.fetch ?? fetch;
	return async (request) => {
		const { provider: providerId, modelId } = splitModelSpec(request.model);
		const provider = providers[providerId];
		if (!provider) {
			throw new Error(
				`Unknown decision provider '${providerId}' in '${request.model}'. Known: ${Object.keys(providers).join(", ")}. ` +
					`Add it under decisionProviders in prospector.json.`,
			);
		}
		const keyVar = provider.apiKeyEnv.find((name) => env[name]);
		const apiKey = keyVar ? env[keyVar] : undefined;
		if (!apiKey) {
			throw new Error(`No credentials for decision provider '${providerId}': set ${provider.apiKeyEnv.join(" or ")}.`);
		}
		const start = Date.now();
		const res = await doFetch(`${provider.baseUrl.replace(/\/$/, "")}/v1/systemone`, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({ model: modelId, state: request.state, questions: request.questions }),
			signal: opts.signal,
		});
		const text = await res.text();
		if (!res.ok) {
			throw new DecisionModelError(`Decision model ${request.model} returned ${res.status}: ${text.slice(0, 300)}`, res.status);
		}
		const body = JSON.parse(text) as { model?: string; answers?: Record<string, DecisionAnswer>; usage?: { input_tokens?: number; output_tokens?: number } };
		const answers = body.answers ?? {};
		for (const name of Object.keys(request.questions)) {
			if (answers[name]?.type !== request.questions[name]!.type) {
				throw new Error(`Decision model ${request.model} returned no ${request.questions[name]!.type} answer for '${name}'.`);
			}
		}
		const inputTokens = body.usage?.input_tokens ?? 0;
		const outputTokens = body.usage?.output_tokens ?? 0;
		return {
			answers,
			model: body.model ?? modelId,
			costUsd: (inputTokens * provider.inputUsdPerMtok + outputTokens * (provider.outputUsdPerMtok ?? 0)) / 1_000_000,
			inputTokens,
			outputTokens,
			durationMs: Date.now() - start,
		};
	};
}

// ─────────────────────────── reading answers ───────────────────────────

/** The answer to `name` when it is of `type`, or a thrown error naming the gap. */
export function answerOf<T extends DecisionAnswer["type"]>(
	response: DecisionResponse,
	name: string,
	type: T,
): Extract<DecisionAnswer, { type: T }> {
	const answer = response.answers[name];
	if (!answer || answer.type !== type) throw new Error(`Decision model returned no ${type} answer for '${name}'.`);
	return answer as Extract<DecisionAnswer, { type: T }>;
}

/**
 * The most probable level of a Score answer. The mean `score` can sit on a level
 * nobody chose (an even split between the ends averages to the middle), so a
 * level-valued field reads the mode. Ties go to the lower level.
 */
export function scoreLevel(answer: ScoreAnswer): number {
	let best = 0;
	let bestP = -1;
	for (const [key, p] of Object.entries(answer.probabilities)) {
		const level = Number(key);
		if (p > bestP || (p === bestP && level < best)) {
			best = level;
			bestP = p;
		}
	}
	return best;
}

// ─────────────────────────── identity ───────────────────────────

const DECISION_IDENTITY_PREFIX = "decision:";

/**
 * The token a decision-model path folds into its node's config fingerprint: the
 * model and the hash of the question set it asked. A different model or a
 * reworded question is a different recipe.
 */
export function decisionIdentity(model: string, questionsHash: string): string {
	return `${DECISION_IDENTITY_PREFIX}${model}#${questionsHash}`;
}

/** The decision model inside an identity token, or undefined for an LLM spec. */
export function decisionModelOf(spec: string): string | undefined {
	if (!spec.startsWith(DECISION_IDENTITY_PREFIX)) return undefined;
	return spec.slice(DECISION_IDENTITY_PREFIX.length).split("#")[0];
}
