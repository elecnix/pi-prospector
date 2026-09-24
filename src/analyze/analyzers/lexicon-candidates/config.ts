/** Configuration for the lexicon-candidates nomination analyzer. */

import { Type, type Static } from "typebox";

export const LexiconCandidatesConfig = Type.Object({
	/**
	 * Ceiling on how many distinct terms a nomination node records.
	 *
	 * This is a **node-size bound, not a cost budget**, and it is deliberately set
	 * high enough that it effectively never binds — the largest real session
	 * nominated 990 terms.
	 *
	 * Capping nomination tightly looks like a cost control but is not one.
	 * Nomination is deterministic and graph-blind, so it re-offers the same ranked
	 * list every session; a tight cap therefore let ordinary words occupy every slot
	 * permanently. Measured over a real corpus: 92% of nomination slots went to terms
	 * already judged, and 62% of sessions hit the cap with vocabulary left unoffered.
	 * Raising it costs nothing, because an already-judged entry is free to re-plan.
	 *
	 * Budgeting the *unjudged* entries instead is worse than the problem it solves:
	 * it makes planning a function of graph state, so each re-run frees the previous
	 * run's slots and buys another batch without end, breaking idempotency. What
	 * actually bounds spend is the corpus-wide cache — a session only ever pays for
	 * vocabulary no earlier session used.
	 */
	maxTermsPerSession: Type.Number(),
	/**
	 * Ceiling on how many distinct two-word phrases a nomination node records.
	 *
	 * Unlike {@link maxTermsPerSession} this one is meant to bind. A verdict is
	 * cached corpus-wide and permanently, so a junk phrase judged once is junk
	 * stored forever — and adjacent words in running prose are overwhelmingly not
	 * idioms. The previous uncapped attempt (#40, later reverted) adjudicated
	 * ~190k distinct phrases over a real corpus and they were almost all noise.
	 *
	 * The cap therefore stays deliberately tight (50): bigrams are ranked by
	 * frequency within the session, so only the session's most-repeated adjacent
	 * pairs reach adjudication. That costs some recall — an idiom occurring once
	 * competes against every other once-occurring pair and may miss the cut —
	 * but it spends the permanent cache conservatively instead of flooding it.
	 * Raising it is ordinary config, picked up by a run with the `config` reason.
	 */
	maxPhrasesPerSession: Type.Number(),
});
export type LexiconCandidatesConfig = Static<typeof LexiconCandidatesConfig>;

export const DEFAULT_LEXICON_CANDIDATES_CONFIG: LexiconCandidatesConfig = {
	maxTermsPerSession: 2000,
	maxPhrasesPerSession: 50,
};
