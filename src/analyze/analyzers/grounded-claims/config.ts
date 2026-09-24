/**
 * Configuration for the grounded-claims consistency checks (issue #100).
 *
 * The issue is explicit that these are threshold-free checks: a check fires or
 * it doesn't, and there is nothing to tune. The only knobs here are *volume
 * caps* — they bound how many signals one turn can contribute to the graph,
 * they never decide whether a discrepancy is a signal.
 *
 * Every knob is part of the config fingerprint, exactly like every other
 * analyzer's config: changing one marks prior nodes stale for the `config`
 * reason; a plain fill leaves them alone and `--revise config` recomputes them
 * with lineage preserved.
 */

import { Type, type Static } from "typebox";

export const GroundedClaimsConfig = Type.Object({
	/**
	 * Maximum number of consistency signals (ungrounded claims plus unacted
	 * requests) a single turn may emit. A cap keeps one runaway turn from
	 * flooding the graph with near-duplicate findings about the same reply;
	 * signals are emitted in extraction order until the cap is reached. This
	 * bounds volume, it never suppresses the first signals a check found.
	 */
	maxSignalsPerTurn: Type.Integer({ minimum: 1 }),
});
export type GroundedClaimsConfig = Static<typeof GroundedClaimsConfig>;

export const DEFAULT_GROUNDED_CLAIMS_CONFIG: GroundedClaimsConfig = {
	maxSignalsPerTurn: 5,
};
