import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_CALL_ID } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "stale-verification.stale-seconds",
		name: "Stale verification time",
		definition: "The seconds spent in passing verification runs (tests, lint, build, gate) that a later edit made stale before any commit used them.",
		measurement: "rule-based",
		unit: "seconds per session",
		denominator: "seconds in passing verification runs (the node stores the passing run count and seconds)",
		limitations: [
			"A command counts as a verification run by the analyzer's own command vocabulary. The corpus verdicts of verification-commands only decide which stale runs the advice names as full checks.",
			"A run must last at least minRunSeconds to count.",
			"An edit makes a run stale only when it can change what the run checked, and an unknown directory always can.",
			"A run with no result or no usable timestamps is untimed and counted apart, never as zero seconds.",
			LIMIT_CALL_ID,
		],
	},
	{
		id: "stale-verification.stale-cause",
		name: "Cause of a stale run",
		definition: "Who made the edit that threw away a passing run.",
		measurement: "rule-based",
		unit: "stale seconds per cause",
		denominator: "stale seconds",
		values: [
			{ value: "agent", meaning: "The agent's own edit." },
			{ value: "user", meaning: "An edit that followed a human prompt." },
			{ value: "subagent", meaning: "An edit from a sub-agent, such as a reviewer." },
		],
		limitations: ["The cause is read from the order of calls and prompts in the transcript, so it is the proximate cause only."],
	},
	{
		id: "stale-verification.stale-outcome",
		name: "Outcome after a stale run",
		definition: "What followed the edit that made a passing run stale.",
		measurement: "rule-based",
		unit: "stale runs per outcome",
		denominator: "stale runs",
		values: [
			{ value: "rerun", meaning: "The agent ran the verification again." },
			{ value: "committed_unverified", meaning: "A commit took the edit with no run in between." },
			{ value: "unverified_at_end", meaning: "The session ended with no rerun and no commit." },
		],
		limitations: ["A session cut off at the end reads as unverified_at_end even when the agent would have run the check next."],
	},
	{
		id: "stale-verification.unverified-commits",
		name: "Unverified commits",
		definition: "The number of commits that took an edit made after the last passing verification run, with no run in between.",
		measurement: "rule-based",
		unit: "commits per session",
		denominator: "none",
		limitations: [
			"Timed-out runs and runs that exited 0 but printed a failure are counted apart (hidden zero exits), and they are not passing runs.",
		],
	},
];
