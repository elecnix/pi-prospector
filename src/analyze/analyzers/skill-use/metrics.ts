import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_CALL_ID, LIMIT_HARNESS } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "skill-use.skill-calls",
		name: "Skill calls",
		definition: "How many times a session loaded each skill, by name, with the way it was loaded and how many of those calls failed.",
		measurement: "rule-based",
		unit: "calls per skill per session; the node also stores the total of skill calls and the number of distinct skills",
		denominator: "tool calls of the session, for the share of tool calls that load a skill",
		values: [
			{ value: "skill_tool", meaning: "The agent called the host's skill tool." },
			{ value: "skill_file", meaning: "The agent read a skill's SKILL.md on a host with no skill tool." },
		],
		limitations: [
			"The figure records use. It does not record which skills were available, because the instruction corpus is read from disk as it is now and past sets are lost.",
			"A call that was issued and never answered counts as a use, and it cannot be told from a failed call.",
			"A session that loaded no skill gets a node with an empty list, so a rate has a denominator.",
			"The failed-call count reads tool outcomes, so it understates failures for sessions indexed before call ids were stored.",
			LIMIT_CALL_ID,
			LIMIT_HARNESS,
		],
	},
];
