/** Configuration for the turn-pair-llm enrichment analyzer. */

import { Type, type Static } from "typebox";

export const TurnPairLLMConfig = Type.Object({
	/** Model tier used for classification. */
	tier: Type.Union([Type.Literal("cheap"), Type.Literal("mid"), Type.Literal("expensive")]),
	/** Sampling temperature. */
	temperature: Type.Number(),
	/** Max pairs to enrich per session per run (cost guard). */
	maxPairsPerSession: Type.Number(),
});
export type TurnPairLLMConfig = Static<typeof TurnPairLLMConfig>;

export const DEFAULT_TURN_PAIR_LLM_CONFIG: TurnPairLLMConfig = {
	tier: "cheap",
	temperature: 0,
	maxPairsPerSession: 20,
};
