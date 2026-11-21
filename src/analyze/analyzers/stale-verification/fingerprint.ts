import type { FingerprintContributor, FingerprintRow } from "../../../fingerprint/contributor.js";
import { newestPerSession } from "../../../fingerprint/latest-node.js";

/** Who made the edit that threw a passing run away: the analyzer's closed set. */
const CAUSES = ["agent", "user", "subagent"] as const;

/**
 * Passing verification time, the part a later edit threw away, who made that
 * edit, and the commits that took an unverified edit. Read from the totals of
 * each session's newest node; the stale runs themselves, which carry command
 * lines, are never read. Deterministic, so objective.
 */
export const staleVerificationFingerprintContributor: FingerprintContributor = {
	def: {
		id: "staleVerification",
		label: "Stale verification",
		description:
			"Time in passing test, lint, build and gate runs, the part a later edit made stale before a commit used it (in seconds by who made the edit), and commits that took an edit no passing run had checked. A run counts as verification by the analyzer's command patterns.",
		kind: "objective",
		analyzers: ["stale-verification"],
		measures: [
			{ kind: "total", id: "passingHours", metric: "stale-verification.stale-seconds", field: "passingSeconds", divisor: 3600, decimals: 1 },
			{ kind: "total", id: "staleHours", metric: "stale-verification.stale-seconds", field: "staleSeconds", divisor: 3600, decimals: 1 },
			{ kind: "sessions", id: "sessionsWithStaleRuns", metric: "stale-verification.stale-seconds", field: "staleSeconds" },
			{ kind: "groups", id: "staleSecondsByCause", metric: "stale-verification.stale-cause", dimensions: { cause: [...CAUSES] }, countField: "seconds" },
			{ kind: "total", id: "unverifiedCommits", metric: "stale-verification.unverified-commits", field: "unverifiedCommits" },
		],
	},
	async read(ctx) {
		const measured = new Set(await ctx.runs("stale-verification"));
		const nodes = await ctx.nodes("stale-verification", {
			passingSeconds: "$.passing_run_seconds",
			staleSeconds: "$.stale_seconds",
			unverifiedCommits: "$.unverified_commit_count",
			...Object.fromEntries(CAUSES.map((c) => [c, `$.stale_seconds_by_cause.${c}`])),
		});
		const rows: FingerprintRow[] = [];
		for (const r of newestPerSession(nodes.filter((n) => measured.has(String(n["session"])) && typeof n["staleSeconds"] === "number"))) {
			const session = r["session"]!;
			rows.push({ session, passingSeconds: r["passingSeconds"]!, staleSeconds: r["staleSeconds"]!, unverifiedCommits: r["unverifiedCommits"]! });
			// A group counts whole units, and a run's seconds come from timestamps that need not be whole.
			for (const cause of CAUSES) {
				const seconds = r[cause];
				rows.push({ session, cause, seconds: typeof seconds === "number" ? Math.round(seconds) : null });
			}
		}
		return { measured: [...measured], rows };
	},
};
