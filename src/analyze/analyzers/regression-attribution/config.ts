/** Configuration for the regression-attribution analyzer. */

import { Type, type Static } from "typebox";

export const RegressionAttributionConfig = Type.Object({
	/** Abbreviated commit shas are recorded but never resolved to a session. */
	reportUnresolvedCommits: Type.Boolean(),
});
export type RegressionAttributionConfig = Static<typeof RegressionAttributionConfig>;

export const DEFAULT_REGRESSION_ATTRIBUTION_CONFIG: RegressionAttributionConfig = {
	reportUnresolvedCommits: true,
};
