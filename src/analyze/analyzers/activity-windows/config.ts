/**
 * Configuration for the activity-windows analyzer.
 *
 * Every knob is part of the config fingerprint: changing one marks prior nodes
 * stale for the `config` reason.
 */

import { Type, type Static } from "typebox";

export const ActivityWindowsConfig = Type.Object({
	/**
	 * The longest gap between two messages that still counts as activity. A longer
	 * gap is the operator away, so only this many seconds of it count. The same
	 * cap `time-economy` uses for active time, so the two agree on what idle is.
	 */
	idleCapSeconds: Type.Integer({ minimum: 1 }),
});
export type ActivityWindowsConfig = Static<typeof ActivityWindowsConfig>;

export const DEFAULT_ACTIVITY_WINDOWS_CONFIG: ActivityWindowsConfig = {
	idleCapSeconds: 300,
};
