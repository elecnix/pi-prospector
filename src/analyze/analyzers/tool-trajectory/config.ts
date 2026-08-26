/**
 * Configuration for the tool-trajectory analyzer.
 *
 * Thresholds for loop detection, polling detection, oscillation windows, and
 * pre-flight gap detection. All are part of the config fingerprint so a change
 * produces a new config identity and, when a run includes the `config` reason,
 * new node versions.
 */

import { Type, type Static } from "typebox";

export const ToolTrajectoryConfig = Type.Object({
	/** Minimum repetitions of the same (tool + normalised args) call to flag a stuck-loop. */
	stuckLoopMin: Type.Integer({ minimum: 2 }),
	/** Minimum repetitions of a read-only command to flag a polling-loop. */
	pollingLoopMin: Type.Integer({ minimum: 2 }),
	/** Sliding window size (in tool calls) for oscillation detection; also bounds thought-oscillation in turns. */
	oscillationWindow: Type.Integer({ minimum: 2 }),
	/** Weight contributed by each stuck-loop signal to the session friction score. */
	stuckLoopWeight: Type.Number({ minimum: 0, maximum: 1 }),
	/** Weight contributed by each polling-loop signal. */
	pollingLoopWeight: Type.Number({ minimum: 0, maximum: 1 }),
	/** Weight contributed by each oscillation signal. */
	oscillationWeight: Type.Number({ minimum: 0, maximum: 1 }),
	/** Weight contributed by each pre-flight gap signal. */
	preFlightGapWeight: Type.Number({ minimum: 0, maximum: 1 }),
	/** Fingerprint similarity above which two reasoning blocks count as near-duplicates (issue #117). */
	thoughtOscillationSimilarity: Type.Number({ minimum: 0, maximum: 1 }),
	/**
	 * Consecutive near-duplicate reasoning repetitions required to flag a
		 * thought-oscillation (issue #117): repetitions counted *beyond the first*
	 * block, so a single repetition — the agent reconsidered once — never fires,
	 * while a run of them does.
	 */
	thoughtOscillationMinRepeat: Type.Integer({ minimum: 1 }),
	/** Weight contributed by each thought-oscillation signal (defaults equal to oscillationWeight). */
	thoughtOscillationWeight: Type.Number({ minimum: 0, maximum: 1 }),
});
export type ToolTrajectoryConfig = Static<typeof ToolTrajectoryConfig>;

export const DEFAULT_TOOL_TRAJECTORY_CONFIG: ToolTrajectoryConfig = {
	stuckLoopMin: 3,
	pollingLoopMin: 3,
	oscillationWindow: 10,
	stuckLoopWeight: 0.3,
	pollingLoopWeight: 0.25,
	oscillationWeight: 0.35,
	preFlightGapWeight: 0.2,
	thoughtOscillationSimilarity: 0.85,
	thoughtOscillationMinRepeat: 2,
	// Equal to oscillationWeight: repeated thinking without progress costs as
	// much attention as repeated acting without progress.
	thoughtOscillationWeight: 0.35,
};