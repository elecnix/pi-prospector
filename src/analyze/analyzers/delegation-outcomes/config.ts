/**
 * Configuration for the delegation-outcomes analyzer.
 *
 * Every knob is part of the config fingerprint: changing one marks prior nodes
 * stale for the `config` reason.
 */

import { Type, type Static } from "typebox";

export const DelegationOutcomesConfig = Type.Object({
	/**
	 * Tool names that hand work to a child agent. Compared case-insensitively.
	 * `Task` and `Agent` are Claude Code's, `subagent` is Pi's.
	 */
	delegationToolNames: Type.Array(Type.String()),
	/**
	 * Background-task statuses, compared case-insensitively. `failed` ones mean the
	 * child failed, `killed` ones mean it was stopped before it finished. A status
	 * in neither list other than `completed` is recorded as `other`.
	 */
	failedBackgroundStatuses: Type.Array(Type.String()),
	killedBackgroundStatuses: Type.Array(Type.String()),
	/** Most delegation events listed on a node. The counts always cover every call. */
	maxEvents: Type.Integer({ minimum: 1 }),
});
export type DelegationOutcomesConfig = Static<typeof DelegationOutcomesConfig>;

export const DEFAULT_DELEGATION_OUTCOMES_CONFIG: DelegationOutcomesConfig = {
	delegationToolNames: ["Task", "Agent", "subagent"],
	failedBackgroundStatuses: ["failed", "error"],
	killedBackgroundStatuses: ["killed", "stopped", "cancelled"],
	maxEvents: 200,
};
