import type { FingerprintContributor } from "../../../fingerprint/contributor.js";

/**
 * Commits, pushes and pull request merges that worked, read from the per-kind
 * counts of each current node. Deterministic, so objective. The event
 * list, which a later version could fill with branch names or messages, is
 * never read.
 */
export const gitCommandsFingerprintContributor: FingerprintContributor = {
	def: {
		id: "gitCommands",
		label: "Git commands",
		description: "Commits, pushes and pull request merges that the sessions ran from the shell and that worked.",
		kind: "objective",
		analyzers: ["git-commands"],
		measures: [
			{ kind: "total", id: "commits", metric: "git-commands.commit", field: "commits" },
			{ kind: "sessions", id: "sessionsCommitting", metric: "git-commands.commit", field: "commits" },
			{ kind: "total", id: "pushes", metric: "git-commands.push", field: "pushes" },
			{ kind: "sessions", id: "sessionsPushing", metric: "git-commands.push", field: "pushes" },
			{ kind: "total", id: "merges", metric: "git-commands.pr-merge", field: "merges" },
			{ kind: "sessions", id: "sessionsMerging", metric: "git-commands.pr-merge", field: "merges" },
		],
	},
	async read(ctx) {
		const measured = new Set(await ctx.runs("git-commands"));
		const nodes = await ctx.nodes("git-commands", { commits: "$.commit.succeeded", pushes: "$.push.succeeded", merges: "$.pr_merge.succeeded" });
		const rows = nodes.filter((r) => measured.has(String(r["session"])));
		return { measured: [...measured], rows };
	},
};
