/**
 * Configuration for the navigation-efficiency analyzer.
 *
 * Every knob is part of the config fingerprint (DESIGN.md: everything the user
 * sets is config, and a different config "is just different") — changing any of
 * these marks prior nodes stale for the `config` reason; a plain fill leaves
 * them alone and `--revise config` recomputes them with lineage preserved. The
 * defaults are starting points, not the Graphectory paper's SWE-bench values:
 * Pi navigation is `read` with offset/limit, `ls`, and `rg`, and the right
 * thresholds come from our own corpus.
 */

import { Type, type Static } from "typebox";

export const NavigationEfficiencyConfig = Type.Object({
	/**
	 * Minimum overlap (0–1) between two consecutive bounded slices of one file,
	 * measured against the shorter slice, for the second to count as a Scroll
	 * step. Disjoint pagination scores 0 and never scrolls.
	 */
	scrollOverlap: Type.Number({ minimum: 0, maximum: 1 }),
	/**
	 * Minimum number of consecutive, mutually overlapping slices of one file
	 * that make a Scroll episode (the paper's example is three).
	 */
	scrollMinSlices: Type.Integer({ minimum: 2 }),
	/**
	 * Minimum depth drop, in structural levels, that counts as backing out
	 * along the branch just explored — and the minimum descent afterwards that
	 * completes a ZoomOut.
	 */
	zoomOutDepthDelta: Type.Integer({ minimum: 1 }),
	/**
	 * Minimum length of an uninterrupted run of views of one path, never
	 * followed by an edit on it, that makes an OverlyDeepZoom episode.
	 */
	viewOnlyRunLen: Type.Integer({ minimum: 2 }),
	/**
	 * Minimum number of returns to one structural region, each after leaving it
	 * for a different region, that make a RepeatedView episode.
	 */
	structuralRevisitMin: Type.Integer({ minimum: 1 }),
	/**
	 * Minimum episodes of one pattern before it earns a proposal. Below this the
	 * episodes are recorded on the metric node — one scroll is noise, and
	 * proposing on noise trains the reader to ignore the output.
	 */
	proposalMinEpisodes: Type.Integer({ minimum: 1 }),
	/** Cap on how many episodes per pattern the node records, so node size is bounded. */
	maxEpisodes: Type.Integer({ minimum: 1 }),
});
export type NavigationEfficiencyConfig = Static<typeof NavigationEfficiencyConfig>;

export const DEFAULT_NAVIGATION_EFFICIENCY_CONFIG: NavigationEfficiencyConfig = {
	scrollOverlap: 0.5,
	scrollMinSlices: 3,
	zoomOutDepthDelta: 2,
	viewOnlyRunLen: 5,
	structuralRevisitMin: 2,
	proposalMinEpisodes: 2,
	maxEpisodes: 10,
};
