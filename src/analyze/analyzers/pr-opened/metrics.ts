import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_CALL_ID } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "pr-opened.pull-request-opened",
		name: "Pull request opened",
		definition: "A pull request that a session opened, recorded as the URL the forge returned and the title the creation call stated.",
		measurement: "rule-based",
		unit: "pull requests per session",
		denominator: "sessions",
		values: [
			{ value: "gh_pr_create", meaning: "A shell `gh pr create` call opened it." },
			{ value: "stacked", meaning: "A stacked-pull-request command, such as `gh stack link --open`, opened it." },
			{ value: "tool", meaning: "A hosted-forge creation tool opened it." },
		],
		limitations: [
			"A pull request opened by hand, or through a command the analyzer does not read, is not seen, and a session with no node did not necessarily fail.",
			"The URL comes from the forge's answer in the tool result, so the analyzer reads tool outcomes. A call without a paired result records no pull request.",
			"Reading a pull request is not opening one, and the rules in detect.ts separate the two.",
			"Nodes exist only for sessions that ran the analyzer. A session indexed before the pairing fix had none, so a fill creates them and no revise run is needed.",
			LIMIT_CALL_ID,
		],
		seriesBreaks: [
			{
				version: "1.1",
				effect: "The `gh stack` verbs, which open a pull request without being `gh pr create`, are read, so sessions that used them gain a node.",
				repair: "prospect analyze --analyzer pr-opened --revise minor",
			},
		],
	},
];
