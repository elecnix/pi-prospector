/** Configuration for the turn-pair-llm enrichment analyzer. */

import { Type, type Static } from "typebox";

export const TurnPairLLMConfig = Type.Object({
	/** Model tier used for classification. */
	tier: Type.Union([Type.Literal("cheap"), Type.Literal("mid"), Type.Literal("expensive")]),
	/** Sampling temperature. */
	temperature: Type.Number(),
	/**
	 * Minimum fraction of high-signal pairs to enrich per session (0–1).
	 * Ensures short sessions always get full coverage.
	 */
	minPairFraction: Type.Number(),
	/**
	 * Hard ceiling on the number of high-signal pairs enriched per session.
	 * Caps cost even on very long sessions. Must be >= 1.
	 */
	maxPairsHardCeiling: Type.Number(),
});
export type TurnPairLLMConfig = Static<typeof TurnPairLLMConfig>;

export const DEFAULT_TURN_PAIR_LLM_CONFIG: TurnPairLLMConfig = {
	tier: "cheap",
	temperature: 0,
	/** Enrich at least 100 % of high-signal pairs (i.e. all of them) up to the ceiling. */
	minPairFraction: 1.0,
	/** Absolute upper bound; keeps cost bounded even on very long sessions. */
	maxPairsHardCeiling: 50,
};

/**
 * Compute how many high-signal pairs to enrich for a session, given the total
 * number of high-signal candidates and the config.
 *
 * The cap is `max(round(minPairFraction * totalHighSignal), 1)`, clamped to
 * `maxPairsHardCeiling`. This ensures short sessions get full coverage while
 * long sessions are bounded for cost.
 */
export function computeEnrichCap(totalHighSignal: number, config: TurnPairLLMConfig): number {
	const minFraction = Math.max(0, Math.min(1, config.minPairFraction));
	const ceiling = Math.max(1, config.maxPairsHardCeiling);
	const fractionCap = Math.max(1, Math.round(minFraction * totalHighSignal));
	return Math.min(fractionCap, ceiling);
}
