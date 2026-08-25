/**
 * Configuration for the files-in-play analyzer.
 *
 * Every knob is part of the config fingerprint (DESIGN.md: everything the user
 * sets is config, and a different config "is just different") — changing any of
 * these marks prior nodes stale for the `config` reason; a plain fill leaves
 * them alone and `--revise config` recomputes them with lineage preserved.
 */

import { Type, type Static } from "typebox";

export const FilesInPlayConfig = Type.Object({
	/**
	 * Length of the sliding window, in consecutive file interactions, over which
	 * repetition is measured (like tool-trajectory's oscillation window, but in
	 * interactions rather than raw tool calls). A window counts as churning when
	 * the share of interactions hitting an already-seen-in-window path reaches
	 * `churnRepeatRatio`.
	 */
	windowSize: Type.Integer({ minimum: 2 }),
	/**
	 * Share of a window's interactions (0–1) that must hit paths already touched
	 * earlier in the same window for that window to count as churning. Linear
	 * work spreads across fresh paths and stays far below this; read→edit→read
	 * cycling over a small set clears it easily.
	 */
	churnRepeatRatio: Type.Number({ minimum: 0, maximum: 1 }),
	/**
	 * Minimum `churn_score` (the fraction of windows classified as churning)
	 * before the node earns a proposal. Below this the measurement is recorded
	 * but stays a clean metric node — a proposal on one warm window would be
	 * noise.
	 */
	proposalChurnThreshold: Type.Number({ minimum: 0, maximum: 1 }),
	/**
	 * Minimum total re-read events (reads of files already read before) before
	 * a qualifying churn score earns a proposal. Recurrence gate, same shape as
	 * uncompleted-leads' per-class threshold: the pattern must recur, not merely
	 * appear once.
	 */
	minRereadsForProposal: Type.Integer({ minimum: 1 }),
	/** Cap on how many top-churned files the node names, so node size is bounded. */
	maxTopFiles: Type.Integer({ minimum: 1 }),
});
export type FilesInPlayConfig = Static<typeof FilesInPlayConfig>;

export const DEFAULT_FILES_IN_PLAY_CONFIG: FilesInPlayConfig = {
	windowSize: 15,
	churnRepeatRatio: 0.5,
	proposalChurnThreshold: 0.4,
	minRereadsForProposal: 3,
	maxTopFiles: 5,
};
