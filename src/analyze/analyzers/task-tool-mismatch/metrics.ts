import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_HARNESS } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "task-tool-mismatch.mismatch-found",
		name: "Task-tool mismatch",
		definition: "Whether the agent avoided a tool it was told to use: the first user message instructed a tool, the tool was in the session's recorded inventory, the agent made zero calls of it, and it made many calls of substitute tools instead.",
		measurement: "rule-based",
		unit: "sessions with a mismatch",
		denominator: "sessions with a recorded tool inventory",
		limitations: [
			"A session whose tool inventory was never captured is unknown and skipped, never read as having no tools. The inventory cannot be recovered by syncing again.",
			"Only imperative sentences in the first user message count as instructions, so an instruction given later is missed.",
			"The first user message of a child session is its task prompt, which an agent wrote.",
			"minSubstituteCalls is config.",
			LIMIT_HARNESS,
		],
	},
	{
		id: "task-tool-mismatch.target-resolution",
		name: "Target resolution of an instructed tool",
		definition: "How an instructed tool or command resolves against the session's inventory.",
		measurement: "rule-based",
		unit: "instructed mentions per resolution",
		denominator: "instructed mentions",
		values: [
			{ value: "direct", meaning: "The instruction names a tool in the inventory." },
			{ value: "shell-command", meaning: "The instruction names a command word, which resolves to the session's shell tool." },
			{ value: "unavailable", meaning: "The instructed tool is not in the inventory." },
		],
		limitations: ["Mentions come from backticked text and known tool names only, and the list of mentions is capped."],
	},
];
