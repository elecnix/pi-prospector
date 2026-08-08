/** Configuration for the lexicon-candidates nomination analyzer. */

import { Type, type Static } from "typebox";

export const LexiconCandidatesConfig = Type.Object({
	/**
	 * How many distinct terms a single session may nominate for classification.
	 *
	 * This is the cost dial for the whole lexicon. Terms are ranked by in-session
	 * frequency, so the commonest words are adjudicated — and cached corpus-wide —
	 * first; within a handful of sessions the cap stops being spent on ordinary
	 * words and starts reaching rare, interesting vocabulary. Raising it makes the
	 * lexicon converge faster at proportionally higher one-time cost.
	 */
	maxTermsPerSession: Type.Number(),
	/**
	 * How many distinct two-word phrases a session may nominate.
	 *
	 * Deliberately smaller than the term budget and separately accounted: bigrams
	 * vastly outnumber unigrams and most are junk, so sharing one budget would let
	 * them crowd out vocabulary that carries signal on its own.
	 */
	maxPhrasesPerSession: Type.Number(),
});
export type LexiconCandidatesConfig = Static<typeof LexiconCandidatesConfig>;

export const DEFAULT_LEXICON_CANDIDATES_CONFIG: LexiconCandidatesConfig = {
	maxTermsPerSession: 40,
	maxPhrasesPerSession: 20,
};
