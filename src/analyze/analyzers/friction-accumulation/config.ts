/**
 * Configuration for the friction-accumulation analyzer (issue #101).
 *
 * Every knob is part of the config fingerprint (DESIGN.md: everything the user
 * sets is config, and a different config "is just different") — changing any of
 * these marks prior nodes stale for the `config` reason; a plain fill leaves
 * them alone and `--revise config` recomputes them with lineage preserved.
 *
 * The heuristic being configured: per-turn friction contributions (from the
 * deterministic per-turn analyzers) are accumulated over the session's turn
 * sequence; the mean contribution rate of the FIRST `windowSize` turns is
 * compared with that of the LAST `windowSize` turns. A session whose friction
 * rate rose by at least `declineThreshold` between those windows is flagged as
 * declining — the shape no per-turn threshold can see.
 */

import { Type, type Static } from "typebox";

export const FrictionAccumulationConfig = Type.Object({
	/**
	 * Length, in consecutive turns, of the first and last comparison windows.
	 * Both windows must be complete for decline to be decidable, so sessions
	 * shorter than `2 * windowSize` are measured but never flagged.
	 */
	windowSize: Type.Integer({ minimum: 2 }),
	/** Minimum turns before any decline can be flagged (recurrence gate). */
	minTurnsForDecline: Type.Integer({ minimum: 2 }),
	/**
	 * How much higher the last window's per-turn friction rate must be than the
	 * first window's (both on the 0–1 contribution scale) for the session to be
	 * flagged declining.
	 */
	declineThreshold: Type.Number({ minimum: 0, maximum: 1 }),
	/**
	 * Minimum total accumulated friction before a qualifying decline earns a
	 * proposal. A rise from "almost nothing" to "very little" is measurement
	 * noise around a clean session; the total must say there was real friction.
	 */
	proposalMinAccumulated: Type.Number({ minimum: 0 }),
	/**
	 * Cap on how much a turn's lexicon/paralinguistic frustration hits (their
	 * summed weights) may add to that turn's contribution, so a turn shouting
	 * three words cannot dominate the accumulation on its own.
	 */
	frustrationWeightCap: Type.Number({ minimum: 0 }),
	/**
	 * Friction weight carried by a turn in which one or more tool-trajectory
	 * signals culminate (stuck-loop, polling-loop, oscillation, pre-flight gap).
	 * Each signal is attributed once — to the turn containing its last
	 * participating message, where the pattern peaked — never to every turn it
	 * spans, which would double-count one loop across the accumulation.
	 */
	trajectorySignalWeight: Type.Number({ minimum: 0, maximum: 1 }),
	/**
	 * Cap on how many per-turn contributions the node lists (the most recent
	 * turns are kept — the tail is where a decline lives), so node size stays
	 * bounded on very long sessions while the full math still runs on all turns.
	 */
	maxListedContributions: Type.Integer({ minimum: 1 }),
});
export type FrictionAccumulationConfig = Static<typeof FrictionAccumulationConfig>;

export const DEFAULT_FRICTION_ACCUMULATION_CONFIG: FrictionAccumulationConfig = {
	windowSize: 4,
	minTurnsForDecline: 8,
	declineThreshold: 0.15,
	proposalMinAccumulated: 1,
	frustrationWeightCap: 0.5,
	trajectorySignalWeight: 0.25,
	maxListedContributions: 40,
};
