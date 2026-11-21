import type { FingerprintContributor } from "../../../fingerprint/contributor.js";

/**
 * The first compression-checklist version that grades lead loss against the
 * results of a session indexed before results carried call ids.
 */
export const PAIRED_SINCE = "1.1";

/** The yes-or-no facets of a summary's checklist. Source references are a ratio, counted under `fullyCovered`. */
const FACETS = ["conclusions_present", "unresolved_items", "abandoned_directions"];

/**
 * How well the compaction summaries keep the working state: graded against the
 * Re-TRAC checklist by fixed rules, so the figures are objective.
 */
export const compressionChecklistFingerprint: FingerprintContributor = {
	def: {
		id: "compaction",
		label: "Compaction summaries",
		description:
			"Sessions that compacted, their compaction summaries, the summaries that cover all four checklist facets, the summaries that cover each yes-or-no facet, and the leads a summary dropped that the agent used again after it. The unresolved-items and abandoned-directions facets match English wording cues, so a summary in another language fails them.",
		kind: "objective",
		analyzers: ["compression-checklist"],
		measures: [
			{ kind: "sessions", id: "compactedSessions", metric: "compression-checklist.facet-coverage", field: "summaries" },
			{ kind: "total", id: "summaries", metric: "compression-checklist.facet-coverage", field: "summaries" },
			{ kind: "total", id: "fullyCovered", metric: "compression-checklist.facet-coverage", field: "fullyCovered" },
			{ kind: "groups", id: "summariesByFacet", metric: "compression-checklist.facet-coverage", dimensions: { facet: FACETS } },
			{ kind: "total", id: "leadsLost", metric: "compression-checklist.leads-lost", field: "leadsLost" },
		],
	},
	async read(ctx) {
		const measured = await ctx.runs("compression-checklist", PAIRED_SINCE);
		const ran = new Set(measured);
		const inRun = (r: { session?: unknown }) => ran.has(String(r.session));
		const rows = (await ctx.nodes("compression-checklist", { summaries: "$.summary_count", fullyCovered: "$.fully_covered_count", leadsLost: "$.leads_lost_count" })).filter(inRun);
		const facetFields = Object.fromEntries(FACETS.map((f) => [f, `$.facet_coverage.${f}`]));
		const graded = (await ctx.items("compression-checklist", "$.summaries", facetFields)).filter(inRun);
		// A JSON true reads as 1. One row per facet a summary covers.
		const facets = graded.flatMap((s) => FACETS.filter((f) => s[f] === 1).map((facet) => ({ session: s["session"]!, facet })));
		return { measured, rows: [...rows, ...facets] };
	},
};
