import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_HARNESS, LIMIT_VERSIONS } from "../../metrics/limits.js";

/** Limits every count of git commands shares. */
const SHARED = [
	"Only a shell command counts. A commit made through an editor integration, a tool that is not the shell, or a script the shell started and the transcript does not show is invisible.",
	"A success is the host's verdict checked against the result text. When a result row holds several results their texts are joined and cannot be attributed to one call, so the host's verdict stands alone there. Each event says whether its text was checked.",
	"A count says the commands ran and worked, never that the work was right.",
	LIMIT_HARNESS,
	LIMIT_VERSIONS,
];

export const metrics: MetricDefinition[] = [
	{
		id: "git-commands.commit",
		name: "Commits",
		definition: "Shell commands that ran `git commit` and worked, counted from the command at command position with dry runs left out.",
		measurement: "rule-based",
		unit: "commits per session",
		denominator: "none",
		limitations: [
			"An amended commit counts like a new one, and a commit that a later reset removed still counts.",
			"`git commit` behind a pipe can fail with exit 0. The result text is checked for `nothing to commit` and similar refusals, and a refusal the markers do not name reads as a success.",
			...SHARED,
		],
	},
	{
		id: "git-commands.push",
		name: "Pushes",
		definition: "Shell commands that ran `git push` and worked, with dry runs (`--dry-run`, `-n`, and a bundle such as `-vn`) left out.",
		measurement: "rule-based",
		unit: "pushes per session",
		denominator: "none",
		limitations: [
			"A forced push counts like any other push.",
			"A rejected push prints a refusal that is checked for, but a refusal the markers do not name reads as a success.",
			...SHARED,
		],
	},
	{
		id: "git-commands.pr-merge",
		name: "Pull request merges",
		definition: "Shell commands that ran `gh pr merge` and worked. `--auto` and `--disable-auto` are not merges: the first arms a later merge and the second cancels one.",
		measurement: "rule-based",
		unit: "merges per session",
		denominator: "none",
		limitations: [
			"A merge made in the forge's web interface, or by a merge queue the session started with `--auto`, is not seen.",
			"A merge through a tool that is not the shell is not seen.",
			...SHARED,
		],
	},
	{
		id: "git-commands.unchecked-result",
		name: "Events whose result text was not checked",
		definition: "Git command events that the host reported as worked and whose result text could not be attributed to the call, so the host's verdict stands alone.",
		measurement: "counted",
		unit: "events per session",
		denominator: "events with a host-reported success",
		limitations: [
			"The share shows how far the counts above rest on the host's verdict alone. A high share means a count may include commands that did not work.",
			"An unanswered call is not counted here: it never worked.",
		],
	},
];
