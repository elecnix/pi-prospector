import type { FingerprintContributor, FingerprintRow } from "../../../fingerprint/contributor.js";

/** The outcomes a delegation call can end in: the analyzer's closed set. */
const OUTCOMES = ["completed", "failed", "killed", "revived", "unanswered", "other"] as const;

/**
 * How often the sessions handed work to child agents, how those hand-offs
 * ended, and how much of the work moved to children. Read from the counts of
 * each current node; the event list, which names tools and agents
 * from the user's own setup, is never read. Deterministic, so objective.
 */
export const delegationOutcomesFingerprintContributor: FingerprintContributor = {
	def: {
		id: "delegation",
		label: "Delegation",
		description:
			"Calls that handed work to a child agent, by how the host recorded their end (completed means no failure was reported, not that the work was right), and the messages of the child sessions beside the parents' own.",
		kind: "objective",
		analyzers: ["delegation-outcomes"],
		measures: [
			{ kind: "total", id: "calls", metric: "delegation-outcomes.outcome", field: "calls" },
			{ kind: "sessions", id: "sessionsDelegating", metric: "delegation-outcomes.outcome", field: "calls" },
			{ kind: "groups", id: "byOutcome", metric: "delegation-outcomes.outcome", dimensions: { outcome: [...OUTCOMES] }, countField: "count" },
			{ kind: "total", id: "childSessions", metric: "delegation-outcomes.work-moved-to-children", field: "childSessions" },
			{ kind: "total", id: "childMessages", metric: "delegation-outcomes.work-moved-to-children", field: "childMessages" },
			{ kind: "total", id: "ownMessages", metric: "delegation-outcomes.work-moved-to-children", field: "ownMessages" },
		],
	},
	async read(ctx) {
		const measured = new Set(await ctx.runs("delegation-outcomes"));
		const nodes = await ctx.nodes("delegation-outcomes", {
			calls: "$.call_count",
			childSessions: "$.child_session_count",
			childMessages: "$.child_message_count",
			ownMessages: "$.own_message_count",
			...Object.fromEntries(OUTCOMES.map((o) => [o, `$.counts.${o}`])),
		});
		const rows: FingerprintRow[] = [];
		for (const r of nodes.filter((n) => measured.has(String(n["session"])))) {
			const session = r["session"]!;
			rows.push({ session, calls: r["calls"]!, childSessions: r["childSessions"]!, childMessages: r["childMessages"]!, ownMessages: r["ownMessages"]! });
			for (const outcome of OUTCOMES) rows.push({ session, outcome, count: r[outcome] ?? null });
		}
		return { measured: [...measured], rows };
	},
};
