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
	/**
	 * Regex sources recognising a tool result that says the harness stopped
	 * waiting for the call (its tool timeout). Matched case-insensitively
	 * against the result text; anchor them at the start, because the harness
	 * writes its own message first, and the same words in a command's output
	 * (a log line, a grep hit) are not a timeout.
	 */
	timeoutResultPatterns: Type.Array(Type.String()),
	/**
	 * A bounded wait loop (`for i in $(seq 1 N); do …; sleep S; done`) counts as
	 * having run to its bound when it lasted at least this fraction of N × S.
	 */
	boundedLoopTolerance: Type.Number({ minimum: 0, maximum: 1 }),
	/** Total seconds of in-call waiting at which the analyzer proposes a change. */
	waitProposalMinSeconds: Type.Number({ minimum: 0 }),
	/** How many calls must run until the harness timed them out before the analyzer proposes a change. */
	timeoutProposalMinCalls: Type.Integer({ minimum: 1 }),
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
	timeoutResultPatterns: [
		"^command did not complete within its \\d+s timeout",
		"^command timed out\\b",
	],
	boundedLoopTolerance: 0.9,
	waitProposalMinSeconds: 600,
	timeoutProposalMinCalls: 3,
	selfMatchProposalMinSeconds: 60,
	evidenceCap: 10,
};
