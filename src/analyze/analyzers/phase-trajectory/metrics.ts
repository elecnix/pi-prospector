import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_HARNESS } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "phase-trajectory.turn-phase",
		name: "Turn phase",
		definition: "The problem-solving phase of one turn, decided from the tool calls the agent made in it.",
		measurement: "rule-based",
		unit: "turns per phase",
		denominator: "turns of the session",
		values: [
			{ value: "navigate", meaning: "The turn read or searched the repository without changing anything." },
			{ value: "reproduce", meaning: "The turn ran a test command before any patch." },
			{ value: "patch", meaning: "The turn changed files or state." },
			{ value: "validate", meaning: "The turn ran a test or check command after a patch. The same command before a patch is reproduce, so order decides the phase." },
			{ value: "other", meaning: "The turn fits no plan phase." },
		],
		limitations: [
			"The phase comes from tool names and commands, so a harness with different tool names shifts it.",
			"A turn gets exactly one phase, even when it did several kinds of work.",
			"Whether a command is read-only or mutating comes from tool-trajectory's argument parser, so the two analyzers agree on what changed something.",
			LIMIT_HARNESS,
		],
	},
	{
		id: "phase-trajectory.phase-signal",
		name: "Phase signals",
		definition: "A deterministic finding about the order or content of a session's phase sequence, with a risk grade.",
		measurement: "rule-based",
		unit: "signals per session",
		denominator: "sessions",
		values: [
			{ value: "premature-patching", meaning: "A patch turn comes before any navigate or reproduce turn. Risk grade: blocking." },
			{ value: "skip-validation", meaning: "A patch exists and nothing validates after the last one. Risk grade: blocking." },
			{ value: "no-patch-termination", meaning: "Real work happened and the session never reached the patch phase. Risk grade: blocking." },
			{ value: "phase-order-violation", meaning: "The phases first appear out of canonical order. Risk grade: blocking." },
			{ value: "prolonged-stagnation", meaning: "At least the configured number of consecutive turns stay in one phase. Risk grade: non-blocking, because it is often legitimate on hard problems." },
		],
		limitations: [
			"Blocking is a risk grade and not behaviour: prospector never intervenes in a session.",
			"A project that verifies its work in a way the classifier does not recognise reads as skipping validation.",
			"A session that only reads and runs commands can read as no-patch-termination, though it was not trying to patch.",
			"Phase signals feed no friction score.",
		],
		seriesBreaks: [
			{
				version: "1.1",
				effect: "Each signal carries a risk class. Detection is unchanged.",
				repair: "prospect analyze --analyzer phase-trajectory --revise minor",
			},
		],
	},
];
