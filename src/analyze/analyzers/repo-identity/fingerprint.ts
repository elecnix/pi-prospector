import type { FingerprintContributor } from "../../../fingerprint/contributor.js";
import { newestPerSession } from "../../../fingerprint/latest-node.js";

/** The hint kinds that can decide a key, and `none`. */
const BASES = ["remote_output", "pr_url", "gh_repo_flag", "command_url", "none"];

/**
 * How many repositories the sessions worked in, and how concentrated they are.
 * Deterministic, so objective.
 *
 * A repository key names a repository, so it never leaves `read`: each key is
 * replaced by an opaque ordinal before the rows reach a measure, and the
 * measures publish only a count of distinct ordinals and the sessions in the
 * busiest one.
 */
export const repoIdentityFingerprintContributor: FingerprintContributor = {
	def: {
		id: "repositories",
		label: "Repositories",
		description: "How many repositories the sessions worked in, the sessions in the busiest one, and which kind of hint placed each session.",
		kind: "objective",
		analyzers: ["repo-identity"],
		measures: [
			{ kind: "distinct", id: "repositories", metric: "repo-identity.repo-key", field: "repository" },
			{ kind: "total", id: "sessionsInBusiest", metric: "repo-identity.repo-key", field: "busiest" },
			{ kind: "groups", id: "byBasis", metric: "repo-identity.hint-basis", dimensions: { basis: BASES } },
		],
	},
	async read(ctx) {
		const measured = new Set(await ctx.runs("repo-identity"));
		const nodes = await ctx.nodes("repo-identity", { key: "$.repo_key", basis: "$.basis" });
		const newest = newestPerSession(nodes.filter((r) => measured.has(String(r["session"]))));

		const ordinals = new Map<string, string>();
		const sessionsPer = new Map<string, number>();
		for (const r of newest) {
			const key = r["key"];
			if (typeof key !== "string") continue;
			if (!ordinals.has(key)) ordinals.set(key, `r${ordinals.size + 1}`);
			const ordinal = ordinals.get(key)!;
			sessionsPer.set(ordinal, (sessionsPer.get(ordinal) ?? 0) + 1);
		}
		let busiest: string | null = null;
		for (const [ordinal, count] of sessionsPer) if (busiest === null || count > sessionsPer.get(busiest)!) busiest = ordinal;

		return {
			measured: [...measured],
			rows: newest.map((r) => {
				const repository = typeof r["key"] === "string" ? ordinals.get(r["key"])! : null;
				return { session: r["session"]!, basis: r["basis"]!, repository, busiest: repository !== null && repository === busiest ? 1 : 0 };
			}),
		};
	},
};
