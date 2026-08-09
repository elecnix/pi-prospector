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
});
export type LexiconCandidatesConfig = Static<typeof LexiconCandidatesConfig>;

export const DEFAULT_LEXICON_CANDIDATES_CONFIG: LexiconCandidatesConfig = {
	maxTermsPerSession: 2000,
};
