/**
 * Configuration for the repetition-collapse analyzer (issue #278).
 *
 * Every knob is part of the config fingerprint, exactly like every other
 * analyzer's config: changing one marks prior nodes stale for the `config`
 * reason; a plain fill leaves them alone and `--revise config` recomputes them
 * with lineage preserved. The thresholds are corpus-dependent by nature — the
 * same ratio separates loops from prose differently on different endpoints —
 * which is why none of them is hard-coded.
 */

import { Type, type Static } from "typebox";

export const RepetitionCollapseConfig = Type.Object({
	/**
	 * Minimum characters a step's reasoning or answer must carry before it is
	 * judged. Short texts cannot loop in any way that costs anything, and a short
	 * `-_-_-_` rule or a `====` heading would otherwise score as a loop. This is a
	 * floor below which nothing is measured, never a trigger: a long text that
	 * does not repeat is judged and passes.
	 */
	minTextChars: Type.Integer({ minimum: 1 }),
	/** Word n-gram length for the word-level measure. */
	wordNgram: Type.Integer({ minimum: 2 }),
	/**
	 * Longest motif, in characters, the character-level measure looks for. A
	 * loop is often sub-word (`CustomCustomCustom…`, `-_-_-_…`), which the
	 * word-level measure cannot see; a longer motif is a sentence, which it can.
	 */
	maxMotifChars: Type.Integer({ minimum: 1 }),
	/**
	 * Repetition score (the stronger of the two measures, 0–1) at or above which
	 * a step is judged collapsed.
	 */
	repetitionThreshold: Type.Number({ minimum: 0, maximum: 1 }),
	/**
	 * Minimum number of collapsed steps that delivered nothing — no answer text
	 * and no tool call — before the session earns a proposal. A loop that still
	 * produced an action is recorded but is not the billed-for-nothing case.
	 */
	minUndeliveredForProposal: Type.Integer({ minimum: 1 }),
});
export type RepetitionCollapseConfig = Static<typeof RepetitionCollapseConfig>;

export const DEFAULT_REPETITION_COLLAPSE_CONFIG: RepetitionCollapseConfig = {
	minTextChars: 2000,
	wordNgram: 4,
	maxMotifChars: 16,
	repetitionThreshold: 0.4,
	minUndeliveredForProposal: 1,
};
