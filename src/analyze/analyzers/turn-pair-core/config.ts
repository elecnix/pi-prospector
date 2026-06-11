/**
 * Configuration for the turn-pair-core analyzer.
 *
 * The friction score is a weighted sum of deterministic signals, clamped to
 * [0, 1]. Weights and thresholds are part of the config so a change produces a
 * new content-addressed config version (and, in deep mode, new node versions).
 */

import { Type, type Static } from "typebox";

export const TurnPairCoreConfig = Type.Object({
	/** Weight applied when a correction is detected. */
	correctionWeight: Type.Number(),
	/** Weight applied per failed tool result (capped). */
	toolFailureWeight: Type.Number(),
	/** Weight applied when the agent produced no text and no tool calls. */
	emptyResponseWeight: Type.Number(),
	/** Bytes of tool output above which we start counting "waste". */
	toolWasteByteThreshold: Type.Number(),
	/** Weight applied when tool output exceeds the waste threshold. */
	toolWasteWeight: Type.Number(),
	/** Friction score at or above which a pair is "high-signal" (for LLM enrichment). */
	highSignalThreshold: Type.Number(),
});
export type TurnPairCoreConfig = Static<typeof TurnPairCoreConfig>;

export const DEFAULT_TURN_PAIR_CORE_CONFIG: TurnPairCoreConfig = {
	correctionWeight: 0.6,
	toolFailureWeight: 0.25,
	emptyResponseWeight: 0.3,
	toolWasteByteThreshold: 20000,
	toolWasteWeight: 0.15,
	highSignalThreshold: 0.5,
};
