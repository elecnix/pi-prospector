/** Configuration for the frustration-lexicon adjudication analyzer. */

import { Type, type Static } from "typebox";

export const FrustrationLexiconConfig = Type.Object({
	/**
	 * Which model judges a term: a tier name (`cheap`/`mid`/`expensive`) or an
	 * explicit `provider/model` spec, which `resolveModelSpec` passes through
	 * unchanged.
	 *
	 * Allowing a concrete model here — rather than only a tier — is what lets this
	 * analyzer run somewhere much cheaper than the rest of the pipeline. Judging one
	 * word is the simplest classification in the system and happens hundreds of
	 * thousands of times, so a small local or free model is a good trade, e.g.
	 * `ollama/gemma4:31b-mlx` or `openrouter/google/gemma-4-31b-it:free`. Set it via
	 * `analyzers["frustration-lexicon"].tier` in prospector.json.
	 *
	 * The model must support forced tool calls: a verdict is cached corpus-wide and
	 * permanently, so `analyze` fails loudly rather than inventing one if the model
	 * returns no structured output.
	 */
	tier: Type.String(),
	/** Sampling temperature. */
	temperature: Type.Number(),
	/**
	 * Minimum confidence for a non-neutral verdict to count as a lexicon entry.
	 *
	 * Applied downstream at match time rather than here, so a low-confidence verdict
	 * is still cached and never re-adjudicated — raising the threshold changes which
	 * entries are *used*, not which words have been paid for.
	 */
	minConfidence: Type.Number(),
	/**
	 * Thinking level for the judgement.
	 *
	 * "off" by default, deliberately: deciding whether a single word expresses
	 * frustration is recognition, not reasoning, and reasoning tokens are billed
	 * as output on a call that runs once per distinct word in the whole corpus.
	 */
	reasoning: Type.Union([
		Type.Literal("off"),
		Type.Literal("minimal"),
		Type.Literal("low"),
		Type.Literal("medium"),
		Type.Literal("high"),
	]),
	/**
	 * Output budget for one adjudication: the forced tool call that carries the
	 * verdict and its rationale.
	 *
	 * 700 by default, and worth raising for a model that writes longer rationales.
	 * The budget only decides whether an answer is cut short, so raising it costs
	 * nothing on a reply that already fits — while a budget too small for the
	 * model's rationale is not a slightly worse verdict, it is *no* verdict: the
	 * reply is truncated, the unit stays missing, and the next run retries the same
	 * prompt and truncates in the same place. Measured at 300 on a model with fuller
	 * rationales, 1-2% of adjudications failed that way.
	 *
	 * Optional, and absent from the default config on purpose: the hashed config is
	 * part of a node's identity, so an unset budget resolved in code keeps every
	 * existing verdict's fingerprint intact. Setting it is an ordinary config change
	 * and marks the analyzer's nodes `config`-stale, as any other override does.
	 */
	maxTokens: Type.Optional(Type.Number()),
	/**
	 * A decision model (`provider/model`, e.g. `jev/jev-1.13.0`) that judges the
	 * term as three Choices in one request (#338). Absent by default.
	 */
	decisionModel: Type.Optional(Type.String()),
});
export type FrustrationLexiconConfig = Static<typeof FrustrationLexiconConfig>;

/** Output budget for one adjudication when the config sets none. */
export const DEFAULT_FRUSTRATION_LEXICON_MAX_TOKENS = 700;

export const DEFAULT_FRUSTRATION_LEXICON_CONFIG: FrustrationLexiconConfig = {
	tier: "cheap",
	temperature: 0,
	minConfidence: 0.5,
	reasoning: "off",
};
