import { newestPerSession, type FingerprintContributor, type FingerprintRow } from "../../../fingerprint/contributor.js";

/** The navigation patterns navigation-efficiency detects: its closed set. */
const PATTERNS = ["scroll", "zoom_out", "overly_deep_zoom", "repeated_view"];

/**
 * Episodes in which the agent moved through the repository in a wasteful
 * order, though every read succeeded. Detected by deterministic rules over the
 * paths it viewed, so objective. The paths stay out.
 */
export const navigationEfficiencyFingerprint: FingerprintContributor = {
	def: {
		id: "navigation",
		label: "Navigation",
		description: "Episodes of wasteful navigation through the repository, by pattern: paging around a point, climbing back up and down again, deep runs of views never edited, and returns to a region already left.",
		kind: "objective",
		analyzers: ["navigation-efficiency"],
		measures: [
			{ kind: "total", id: "episodes", metric: "navigation-efficiency.navigation-pattern", field: "episodes" },
			{ kind: "sessions", id: "sessionsWithEpisode", metric: "navigation-efficiency.navigation-pattern", field: "episodes" },
			{ kind: "groups", id: "episodesByPattern", metric: "navigation-efficiency.navigation-pattern", dimensions: { pattern: PATTERNS }, countField: "count" },
		],
	},
	async read(ctx) {
		const counts = Object.fromEntries(PATTERNS.map((p) => [p, `$.pattern_counts.${p}`]));
		const nodes = newestPerSession(await ctx.nodes("navigation-efficiency", { views: "$.view_count", ...counts }), "views");
		const rows: FingerprintRow[] = [];
		for (const node of nodes) {
			const session = node["session"]!;
			let episodes = 0;
			for (const p of PATTERNS) {
				const count = node[p];
				if (typeof count !== "number") continue;
				episodes += count;
				rows.push({ session, pattern: p, count });
			}
			rows.push({ session, episodes });
		}
		return { measured: nodes.map((r) => String(r["session"])), rows };
	},
};
