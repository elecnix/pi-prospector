/** Configuration for the turn-frustration hit analyzer. */

import { Type, type Static } from "typebox";

export const TurnFrustrationConfig = Type.Object({
	/**
	 * Minimum confidence a lexicon verdict needs before its term is matched
	 * against turns. Low-confidence verdicts stay cached — they are simply not
	 * used — so raising this never causes a word to be re-adjudicated.
	 */
	minConfidence: Type.Number(),
	/** Friction weight contributed by one single-term lexicon hit. */
	lexiconHitWeight: Type.Number(),
	/**
	 * Friction weight contributed by one phrase hit. Higher than a single term: a
	 * multi-word expression is far less likely to be incidental.
	 *
	 * A phrase and its component words are independently judged subjects, so both
	 * can fire on one turn and their weights both count. That is deliberate — each
	 * is a real signal — and the sum is only ever used for *ranking* which turns
	 * deserve a closer look, never as a threshold.
	 */
	phraseHitWeight: Type.Number(),
	/**
	 * Friction weight contributed by one lexicon-free marker (shouting, punctuation,
	 * elongation). Lower than a lexicon hit: form is suggestive, vocabulary is
	 * explicit.
	 */
	paralinguisticWeight: Type.Number(),
	/** Whether to record praise hits as well as frustration ones. */
	includePraise: Type.Boolean(),
});
export type TurnFrustrationConfig = Static<typeof TurnFrustrationConfig>;

export const DEFAULT_TURN_FRUSTRATION_CONFIG: TurnFrustrationConfig = {
	minConfidence: 0.5,
	lexiconHitWeight: 0.5,
	phraseHitWeight: 0.7,
	paralinguisticWeight: 0.3,
	includePraise: true,
};
