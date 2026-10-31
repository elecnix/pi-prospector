import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_CALL_ID } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "tool-trajectory.trajectory-signal",
		name: "Trajectory signals",
		definition: "Per session, the number of problematic tool-call patterns in the ordered action stream.",
		measurement: "rule-based",
		unit: "signals per session, or per 1000 tool calls to correct for length",
		denominator: "sessions, or tool calls",
		values: [
			{ value: "stuck-loop", meaning: "The same tool with near-identical arguments, repeated without an intervening success." },
			{ value: "polling-loop", meaning: "A read-only command repeated while waiting for external state." },
			{ value: "oscillation", meaning: "An action followed within a window by its inverse on the same target." },
			{ value: "pre-flight-gap", meaning: "A mutating command that failed on a precondition an earlier command could have established." },
			{ value: "no-effect-edit", meaning: "A successful edit that replaced a string with itself." },
			{ value: "thought-oscillation", meaning: "Repeated near-duplicate reasoning without progress." },
		],
		limitations: [
			"A long session has more chances for each signal.",
			"A stuck-loop shows a pattern and does not prove the agent was wrong, because a legitimate retry loop looks the same.",
			"The thresholds (stuckLoopMin, pollingLoopMin, oscillationWindow) are config.",
			LIMIT_CALL_ID,
		],
		seriesBreaks: [
			{
				version: "7.0",
				effect: "The no-effect-edit detector appears, so signals exist on sessions that had none.",
				repair: "prospect analyze --analyzer tool-trajectory --revise major",
			},
			{
				version: "7.1",
				effect: "The action stream pairs results with id-less stored calls. Failures that read as successes now count, so pre-flight gaps rise and stuck-loops end correctly on sessions indexed before call ids. A tool-trajectory re-run changes the identity of units in turn-pair-llm, friction-accumulation, routing-opportunity and session-overview.",
				repair: "prospect analyze --analyzer tool-trajectory --revise minor",
			},
		],
	},
];
