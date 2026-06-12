/** Configuration for the proposal-validate (replay test) analyzer (issue #6). */

import { Type, type Static } from "typebox";

export const ProposalValidateConfig = Type.Object({
	/**
	 * Model tier used to re-classify replay turns. Should differ from the tier
	 * that *generated* the proposal (turn-pair-llm uses `cheap`) so the validator
	 * is not the same model rubber-stamping its own output. Defaults to `mid`.
	 */
	validatorTier: Type.Union([Type.Literal("cheap"), Type.Literal("mid"), Type.Literal("expensive")]),
	/** Sampling temperature for the validator. */
	temperature: Type.Number(),
	/** Max originating turns to replay per proposal (cost guard, highest-friction first). */
	maxReplayTurns: Type.Number(),
	/**
	 * Minimum fraction of friction turns the rule must avert to be `supported`.
	 * The grounded `validated_score` is `averted / baseline-friction turns`.
	 */
	supportThreshold: Type.Number(),
});
export type ProposalValidateConfig = Static<typeof ProposalValidateConfig>;

export const DEFAULT_PROPOSAL_VALIDATE_CONFIG: ProposalValidateConfig = {
	validatorTier: "mid",
	temperature: 0,
	maxReplayTurns: 5,
	supportThreshold: 0.5,
};
