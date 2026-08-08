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
});
export type FrustrationLexiconConfig = Static<typeof FrustrationLexiconConfig>;

export const DEFAULT_FRUSTRATION_LEXICON_CONFIG: FrustrationLexiconConfig = {
	tier: "cheap",
	temperature: 0,
	minConfidence: 0.5,
};
