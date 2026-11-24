import type { FingerprintContributor } from "../../../fingerprint/contributor.js";
import { DETECTORS } from "./pipeline.js";

/**
 * Repeated prompts, tool calls and tool results, counted once each however many
 * sessions report them. A cluster repeats in every sibling session's node, so it
 * is told apart by the hashes of its members, which are counted and never
 * printed. The text of a member is never read. Deterministic, so objective.
 */
export const similarityClusterFingerprint: FingerprintContributor = {
	def: {
		id: "repeats",
		label: "Repeated prompts and calls",
		description:
			"Distinct clusters of near-identical user prompts, tool calls and tool results, within a session or across the sessions of a repository, by kind and by whether the members are the same after normalising (exact) or only close (near). A cluster counts once however many sessions report it. Each session reports at most its 100 strongest clusters by default, a close cluster is a pair, and the pool takes in the repository's other sessions even when the filter leaves them out. So the count says how much repeats, not how often, and one that rests on few sessions measures a small corner of the corpus.",
		kind: "objective",
		analyzers: ["similarity-cluster"],
		measures: [
			{ kind: "sessions", id: "sessionsReportingAny", metric: "similarity-cluster.cluster", field: "seen" },
			{ kind: "corpusCount", id: "clusters", metric: "similarity-cluster.cluster", field: "seen", key: "cluster", of: "clusters" },
			{
				kind: "corpusGroups",
				id: "byKind",
				metric: "similarity-cluster.cluster",
				dimensions: { kind: [...DETECTORS], match: ["exact", "near"] },
				key: "cluster",
				total: "clusters",
				of: "clusters",
			},
		],
	},
	async read(ctx) {
		// Every session the analyzer judged has a node, with no cluster when nothing repeats.
		const measured = (await ctx.nodes("similarity-cluster", {})).map((r) => String(r["session"]));
		const clusters = await ctx.items("similarity-cluster", "$.clusters", {
			kind: "$.detector",
			exact: "$.exact",
			first: "$.members[0].normalized_hash",
			second: "$.members[1].normalized_hash",
		});
		return {
			measured,
			rows: clusters.map((c) => {
				// Every member of an exact cluster has one hash, and a near one is a pair, so two hashes name either.
				const match = c["exact"] === 1 ? "exact" : "near";
				const cluster = [c["kind"], match, ...[String(c["first"]), String(c["second"])].sort()].join(" ");
				return { session: c["session"]!, seen: 1, kind: c["kind"]!, match, cluster };
			}),
		};
	},
};
