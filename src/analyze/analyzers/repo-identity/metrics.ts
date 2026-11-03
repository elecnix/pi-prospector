import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_HARNESS, LIMIT_VERSIONS } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "repo-identity.repo-key",
		name: "Repository key",
		definition: "The forge address of the repository a session worked in, as `host/owner/name` in lowercase, read from the git commands the session ran.",
		measurement: "rule-based",
		unit: "sessions per repository key",
		denominator: "sessions with at least one message, including those with no key",
		limitations: [
			"A session has a key only when its own commands touched a forge address: a `git remote`, `git push`, `git fetch` or `git pull` that printed one, a `gh pr` command that printed a pull request URL, a `gh --repo` flag, or a `git clone` or `git remote add` that wrote one. A session that never ran such a command has no key, so sessions without a key are missing from a concentration figure and not spread across repositories.",
			"The strongest hint present decides, and within it the address with the most hints. A session that worked in one repository and printed a pull request URL from another can take the other key.",
			"A command is left out when it ran in a directory outside the session's working directory (`cd /elsewhere && …`, `git -C /elsewhere …`, a path that is not under it). A path held in a variable cannot be resolved and is left out too.",
			"Only a single-result row's text is read, since joined texts cannot be attributed to one call. A call with a parallel sibling can lose its hint.",
			"A repository with no forge remote, or a remote on a host that prints a different address shape, gets no key.",
			LIMIT_HARNESS,
			LIMIT_VERSIONS,
		],
	},
	{
		id: "repo-identity.hint-basis",
		name: "Repository hint basis",
		definition: "Which kind of hint decided a session's repository key, or `none` when no hint existed.",
		measurement: "rule-based",
		unit: "sessions per basis",
		denominator: "sessions with at least one message",
		values: [
			{ value: "remote_output", meaning: "The remote address printed by `git remote`, `git push`, `git fetch` or `git pull`." },
			{ value: "pr_url", meaning: "A pull request or issue URL printed by a `gh pr` command." },
			{ value: "gh_repo_flag", meaning: "The `-R` or `--repo` value of a `gh` command." },
			{ value: "command_url", meaning: "A forge address written in a `git clone` or `git remote add` or `set-url` command." },
			{ value: "none", meaning: "No hint. The key is null." },
		],
		limitations: [
			"The basis ranks how direct the evidence is. A `command_url` key says where the session cloned from or pointed a remote, which is weaker evidence of where it worked than a remote git printed.",
			"The share of sessions with `none` is the coverage of the key. Read every per-repository figure with that share beside it.",
		],
	},
];
