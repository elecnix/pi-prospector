import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_CALL_ID, LIMIT_USER_ROLE, LIMIT_VERSIONS } from "../../metrics/limits.js";

const REPAIR = "prospect analyze --analyzer session-overview --revise minor (costs model calls)";

export const metrics: MetricDefinition[] = [
	{
		id: "session-overview.friction-point",
		name: "Friction points",
		definition: "Per session, the distinct friction points that the synthesising model enumerated, each with what went wrong, what should change, the evidence and a severity.",
		measurement: "inferred",
		unit: "friction points per session",
		denominator: "none",
		values: [
			{ value: "low", meaning: "A minor friction point." },
			{ value: "medium", meaning: "A friction point that cost the user effort." },
			{ value: "high", meaning: "A friction point that blocked or reversed work." },
		],
		limitations: [
			"A model enumerates the points from a digest of the session, so the count depends on the digest, the prompt and the model. A longer session has more points to find, and the enrichment cap scales with its length.",
			"A session with no friction still produces a node with an empty list, so zero means the model found none and not that the session went unread.",
			"The digest holds the signals that other analyzers stored, so every limit on those signals applies here too.",
			LIMIT_USER_ROLE,
			LIMIT_VERSIONS,
		],
		seriesBreaks: [
			{
				version: "1.3",
				effect: "The digest carries tool evidence for high-signal turns, so the model sees the failing command and not only the user's wording.",
				repair: REPAIR,
			},
			{
				version: "1.5",
				effect: "The digest carries the frustration terms of each turn, so friction expressed in another language or with no words becomes visible. Version 1.11 to 1.13 then narrow which hits count: muted terms, terms carried by more than a tenth of the corpus's turns, and text the person did not type.",
				repair: REPAIR,
			},
			{
				version: "1.7",
				effect: "The digest carries failed generations from failure-modes, so a turn that never reached a tool becomes visible.",
				repair: REPAIR,
			},
			{
				version: "1.8",
				effect: "The digest carries assistant cognition (confusion, indecision, surprise), and version 1.9 adds the plan-compliance line and 1.10 adds event-centered evidence slices.",
				repair: REPAIR,
			},
			{
				version: "1.13",
				effect: "The units become missing after a revise of failure-modes (1.3) or tool-trajectory (7.1), because their output keys fold into this analyzer's identity. The next run that reaches them recomputes the overview and costs model calls.",
				repair: "prospect analyze --all --analyzer session-overview fills the missing units; nothing recomputes until a person runs it",
			},
		],
	},
	{
		id: "session-overview.positive-signal",
		name: "Positive signals",
		definition: "Per session, the observations that something went well, each tagged with one signal from a closed list.",
		measurement: "inferred",
		unit: "signals per session",
		denominator: "none",
		values: [
			{ value: "task-completed-without-correction", meaning: "The task finished and the user never corrected the agent." },
			{ value: "correction-then-clean-recovery", meaning: "The user corrected the agent and the agent recovered cleanly." },
			{ value: "low-tool-failure-density", meaning: "Few of the tool calls failed." },
		],
		limitations: [
			"The signals give the synthesis a baseline of a good session, so subtle friction stands out against it. They are not an outcome label.",
			"The model picks the signal from the digest, so a session that went well can carry none.",
			LIMIT_CALL_ID,
			LIMIT_VERSIONS,
		],
	},
	{
		id: "session-overview.improvement-proposal",
		name: "Improvement proposals",
		definition: "Per session, the concrete, reviewable suggestions to change a steering artifact, one per friction point plus reinforcement proposals for patterns worth keeping.",
		measurement: "inferred",
		unit: "proposals per session",
		denominator: "none",
		values: [
			{ value: "agents_md", meaning: "Target: a standing instruction file." },
			{ value: "skill", meaning: "Target: a skill." },
			{ value: "prompt", meaning: "Target: a prompt." },
			{ value: "config", meaning: "Target: configuration." },
			{ value: "workflow", meaning: "Target: a workflow." },
			{ value: "extension", meaning: "Target: the set of installed extensions. The package comes from the failure-modes catalogue and never from the model." },
			{ value: "general", meaning: "Target: none of the above." },
		],
		limitations: [
			"The values are the proposal's target type. Its severity is friction, correction, waste, suggestion or reinforcement, and it describes why the proposal exists and not how urgent it is.",
			"The model rates its own confidence, which is not a measure of correctness. A replay-validated score replaces it for ranking once a validation node exists.",
			"Overlapping proposals across sessions are kept on purpose, and the listing groups them at display time. A count of proposals therefore overstates the count of distinct problems.",
			"A proposal's identity comes from the summary node's output key and its position, so a recomputed summary materialises new proposals beside decided ones.",
			LIMIT_VERSIONS,
		],
		seriesBreaks: [
			{
				version: "1.1",
				effect: "Each proposal carries the ids of the session's high-signal turns, which proposal validation replays.",
				repair: REPAIR,
			},
			{
				version: "1.7",
				effect: "The extension target type exists, so earlier nodes cannot propose a package.",
				repair: REPAIR,
			},
		],
	},
];
