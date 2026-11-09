/** Configuration for the regression-verdict analyzer. */

import { Type, type Static } from "typebox";

export const RegressionVerdictConfig = Type.Object({
	/** Model tier used for the verdict, unless `model` names one explicitly. */
	tier: Type.Union([Type.Literal("cheap"), Type.Literal("mid"), Type.Literal("expensive")]),
	/** An explicit `provider/model` spec, used instead of the tier when set. */
	model: Type.Optional(Type.String()),
	/** Sampling temperature. Zero, so an identical packet asks an identical question. */
	temperature: Type.Number(),
	maxTokens: Type.Integer({ minimum: 1 }),
	/** Skip sessions longer than this, as a hard cost ceiling. 0 disables the cap. */
	maxMessages: Type.Integer({ minimum: 0 }),
	/** Cap on each list in the evidence packet. */
	maxFailures: Type.Integer({ minimum: 1 }),
	maxCommits: Type.Integer({ minimum: 1 }),
	maxStatements: Type.Integer({ minimum: 1 }),
	maxFiles: Type.Integer({ minimum: 1 }),
});
export type RegressionVerdictConfig = Static<typeof RegressionVerdictConfig>;

export const DEFAULT_REGRESSION_VERDICT_CONFIG: RegressionVerdictConfig = {
	tier: "cheap",
	temperature: 0,
	maxTokens: 900,
	maxMessages: 0,
	maxFailures: 12,
	maxCommits: 10,
	maxStatements: 18,
	maxFiles: 20,
};
