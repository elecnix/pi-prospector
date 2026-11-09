/** Configuration for the regression-signal analyzer. */

import { Type, type Static } from "typebox";

export const RegressionSignalConfig = Type.Object({
	/** Minimum number of signals before a claim is filed. */
	minSignals: Type.Integer({ minimum: 1 }),
	/** Whether to read assistant thinking, not only visible text. */
	readThinking: Type.Boolean(),
});
export type RegressionSignalConfig = Static<typeof RegressionSignalConfig>;

export const DEFAULT_REGRESSION_SIGNAL_CONFIG: RegressionSignalConfig = {
	minSignals: 2,
	readThinking: true,
};
