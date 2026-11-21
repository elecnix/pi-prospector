import type { FingerprintContributor } from "../../../fingerprint/contributor.js";
import { newestPerSession } from "../../../fingerprint/latest-node.js";

/**
 * The first pr-opened version that reads the `gh stack` verbs. A session last
 * run by 1.0 may have opened a stacked pull request the analyzer did not see,
 * so it is not measured.
 */
export const STACKED_SINCE = "1.1";

/**
 * Pull requests the sessions opened, by the kind of call that opened them.
 * Deterministic, so objective. The URL keeps a pull request from counting twice
 * when a session grew between runs; it is read to compare and never leaves `read`.
 */
export const prOpenedFingerprintContributor: FingerprintContributor = {
	def: {
		id: "pullRequests",
		label: "Pull requests opened",
		description: "Pull requests the sessions opened, and how: `gh pr create`, a stacked-PR command, or a forge tool.",
		kind: "objective",
		analyzers: ["pr-opened"],
		measures: [
			{ kind: "total", id: "opened", metric: "pr-opened.pull-request-opened", field: "opened" },
			{ kind: "sessions", id: "sessionsOpening", metric: "pr-opened.pull-request-opened", field: "opened" },
			{ kind: "groups", id: "byVia", metric: "pr-opened.pull-request-opened", dimensions: { via: ["gh_pr_create", "stacked", "tool"] } },
		],
	},
	async read(ctx) {
		const measured = await ctx.runs("pr-opened", STACKED_SINCE);
		const opened = new Set(measured);
		const nodes = await ctx.nodes("pr-opened", { url: "$.pull_request.url", via: "$.pull_request.via" });
		const rows = newestPerSession(
			nodes.filter((r) => opened.has(String(r["session"])) && typeof r["url"] === "string"),
			(r) => String(r["url"]),
		);
		return { measured, rows: rows.map((r) => ({ session: r["session"]!, via: r["via"]!, opened: 1 })) };
	},
};
