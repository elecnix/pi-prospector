import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_USER_ROLE, LIMIT_VERSIONS } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "friction-accumulation.accumulated-friction",
		name: "Accumulated friction",
		definition: "The sum over a session's turns of each turn's deterministic friction: the turn-pair-core score, the priced weight of its frustration hits (capped), and the weight of each trajectory signal, attributed once to the turn where the signal ends.",
		measurement: "rule-based",
		unit: "friction points per session, and the mean per turn",
		denominator: "turns of the session (the mean)",
		limitations: [
			"The sum grows with session length, so compare the mean per turn, or the decline verdict, across sessions of different length.",
			"A frustration hit counts at its priced weight, which depends on how specific the term is in the corpus at the time the node was computed. A term carried by more than a tenth of the corpus's turns adds nothing.",
			"A muted lexicon term adds nothing.",
			"The node keeps only the most recent turn contributions, so the list shows the end of a long session.",
			LIMIT_USER_ROLE,
			LIMIT_VERSIONS,
		],
		seriesBreaks: [
			{
				version: "1.1",
				effect: "A muted lexicon term stops contributing, and hits are read at their current generation so an unmute does not count a signal twice.",
				repair: "prospect analyze --analyzer friction-accumulation --revise minor",
			},
			{
				version: "1.2",
				effect: "A term carried by more than a tenth of the corpus's turns adds nothing, replacing a list of English function words. The score narrows.",
				repair: "prospect analyze --analyzer friction-accumulation --revise minor",
			},
		],
	},
	{
		id: "friction-accumulation.decline-verdict",
		name: "Friction decline verdict",
		definition: "Whether a session's per-turn friction rate rose between its first and last window of turns by at least the configured threshold, together with both window rates and their difference.",
		measurement: "rule-based",
		unit: "rate per turn for each window, and the difference between them",
		denominator: "turns in a window",
		limitations: [
			"The verdict measures the slope and not the level: a steadily rough session never flags, and a calm session that ends rough does.",
			"A session shorter than two windows has no verdict worth reading. The window size and the decline threshold (0.15 by default) are config.",
			"A proposal needs both a flagged decline and a floor of total accumulated friction, so a flagged decline alone does not earn one.",
			"The verdict inherits the limits of the signals it sums, including the tool-trajectory fix for sessions indexed before call ids (tool-trajectory 7.1), which changes this analyzer's source set.",
			LIMIT_VERSIONS,
		],
	},
];
