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
	 * Friction weight contributed by one lexicon-free marker (shouting, punctuation,
	 * elongation). Lower than a lexicon hit: form is suggestive, vocabulary is
	 * explicit.
	 */
	paralinguisticWeight: Type.Number(),
	/** Whether to record praise hits as well as frustration ones. */
	includePraise: Type.Boolean(),
	/**
	 * Multiplier applied to every signal hit on a turn that also carries a lone
	 * exclamation mark (`putain!`, `wait, no!`). A single `!` is polarity-agnostic
	 * — it fires as no signal of its own — so it only *scales* the weight of the
	 * signals the turn already carries; `1` disables scaling entirely.
	 */
	exclamationMultiplier: Type.Number(),
});
export type TurnFrustrationConfig = Static<typeof TurnFrustrationConfig>;

export const DEFAULT_TURN_FRUSTRATION_CONFIG: TurnFrustrationConfig = {
	minConfidence: 0.5,
	lexiconHitWeight: 0.5,
	paralinguisticWeight: 0.3,
	includePraise: true,
exclamationMultiplier: 1.5,
};
