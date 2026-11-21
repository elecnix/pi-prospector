import type { FingerprintContributor } from "../../../fingerprint/contributor.js";

/**
 * The first revive-chains version that finds a revived child's result in a
 * session indexed before tool results carried call ids. An older run read
 * those sessions as having no chain at all, a false zero.
 */
export const PAIRED_SINCE = "1.1";

/**
 * How often a person drives a child agent turn by turn, each exchange paid for
 * as a fresh spawn. Counted from the orchestration tool's own results, so the
 * figures are objective.
 */
export const reviveChainsFingerprint: FingerprintContributor = {
	def: {
		id: "reviveChains",
		label: "Revive chains",
		description:
			"Chains of consecutive revived child-agent results, the sign of a back-and-forth with one child that each time costs a new spawn, and the spawns a persistent child would have saved. Counted from the orchestration tool's results, not from language.",
		kind: "objective",
		analyzers: ["revive-chains"],
		measures: [
			{ kind: "sessions", id: "sessionsWithChains", metric: "revive-chains.redundant-spawns", field: "chains" },
			{ kind: "total", id: "chains", metric: "revive-chains.redundant-spawns", field: "chains" },
			{ kind: "total", id: "redundantSpawns", metric: "revive-chains.redundant-spawns", field: "redundantSpawns" },
		],
	},
	async read(ctx) {
		const measured = await ctx.runs("revive-chains", PAIRED_SINCE);
		const ran = new Set(measured);
		const rows = await ctx.nodes("revive-chains", { chains: "$.chain_count", redundantSpawns: "$.redundant_spawn_count" });
		return { measured, rows: rows.filter((r) => ran.has(String(r["session"]))) };
	},
};
