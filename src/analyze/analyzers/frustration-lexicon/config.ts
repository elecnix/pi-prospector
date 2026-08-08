/** Configuration for the frustration-lexicon adjudication analyzer. */

import { Type, type Static } from "typebox";

export const FrustrationLexiconConfig = Type.Object({
	/** Model tier used to judge a term. One small call per previously unseen word. */
	tier: Type.Union([Type.Literal("cheap"), Type.Literal("mid"), Type.Literal("expensive")]),
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
