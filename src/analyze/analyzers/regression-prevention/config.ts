/** Configuration for the regression-prevention synthesis. */

import { Type, type Static } from "typebox";

export const RegressionPreventionConfig = Type.Object({
	/** A cause class needs at least this many verdicts before it earns a proposal. */
	minOccurrences: Type.Integer({ minimum: 1 }),
	/** Cap on how many example sessions a proposal names. */
	maxExamples: Type.Integer({ minimum: 1 }),
	/** Only count verdicts at or above this confidence. */
	minConfidence: Type.Number(),
});
export type RegressionPreventionConfig = Static<typeof RegressionPreventionConfig>;

export const DEFAULT_REGRESSION_PREVENTION_CONFIG: RegressionPreventionConfig = {
	minOccurrences: 3,
	maxExamples: 4,
	minConfidence: 0.4,
};
