/**
 * Configuration for the time-economy analyzer (issue #306).
 *
 * Every knob is part of the config fingerprint, exactly like every other
 * analyzer's config: changing one marks prior nodes stale for the `config`
 * reason; a plain fill leaves them alone and `--revise config` recomputes them
 * with lineage preserved.
 */

import { Type, type Static } from "typebox";

export const TimeEconomyConfig = Type.Object({
	/**
	 * Tool names treated as shell execution. A shell call is grouped by its
	 * leading command words; any other tool is grouped by its tool name.
	 */
	shellToolNames: Type.Array(Type.String()),
	/** How many leading command words name a shell call's family. */
	familyWords: Type.Integer({ minimum: 1 }),
	/** How many families the node keeps, ranked by total seconds. */
	topFamilies: Type.Integer({ minimum: 1 }),
	/**
	 * The longest gap between two messages that still counts as active time.
	 * A longer gap is the operator away, not the session working, so only this
	 * much of it counts. A gap a tool call spans is never capped: the call was
	 * running the whole time.
	 */
	idleCapSeconds: Type.Integer({ minimum: 1 }),
	/** A standalone `sleep N` with N at least this long counts as a wait. */
	minSleepSeconds: Type.Number({ minimum: 0 }),
	/**
	 * Regex sources for commands that block until something outside the session
	 * changes (a CI run, a container, a deployment). Matched case-insensitively
	 * anywhere in the command.
	 */
	blockingWaitPatterns: Type.Array(Type.String()),
	/** Total seconds of in-call waiting at which the analyzer proposes a change. */
	waitProposalMinSeconds: Type.Number({ minimum: 0 }),
	/** A self-matching wait loop that ran at least this long earns a proposal. */
	selfMatchProposalMinSeconds: Type.Number({ minimum: 0 }),
	/** How many message ids a node keeps as evidence for one finding. */
	evidenceCap: Type.Integer({ minimum: 1 }),
});
export type TimeEconomyConfig = Static<typeof TimeEconomyConfig>;

export const DEFAULT_TIME_ECONOMY_CONFIG: TimeEconomyConfig = {
	shellToolNames: ["bash"],
	familyWords: 2,
	topFamilies: 10,
	idleCapSeconds: 300,
	minSleepSeconds: 10,
	blockingWaitPatterns: [
		"\\bgh run watch\\b",
		"\\bgh pr checks\\b.*--watch\\b",
		"\\bkubectl (rollout status|wait)\\b",
		"\\bdocker (compose )?wait\\b",
		"\\baws [a-z0-9-]+ wait\\b",
	],
	waitProposalMinSeconds: 600,
	selfMatchProposalMinSeconds: 60,
	evidenceCap: 10,
};
