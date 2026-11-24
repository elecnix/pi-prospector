import type { FingerprintContributor } from "../../../fingerprint/contributor.js";
import { metricValues } from "../../metrics/values.js";
import { metrics } from "./metrics.js";

const LEAD_TYPES = metricValues(metrics, "uncompleted-leads.lead");

/**
 * The first uncompleted-leads version that reads the tool results of a session
 * indexed before results carried call ids. An older run found no lead there.
 */
export const PAIRED_SINCE = "1.1";

/**
 * Leads that tool output surfaced (a path, a URL, a suggested command) and that
 * no later tool call pursued. Extracted and matched by shape, so the figures are
 * objective. Read from `uncompleted_by_type`, which counts every lead; the lead
 * list in the node is capped.
 */
export const uncompletedLeadsFingerprint: FingerprintContributor = {
	def: {
		id: "uncompletedLeads",
		label: "Uncompleted leads",
		description:
			"Leads that tool output surfaced (file paths, URLs, suggested commands) and how many of them no later tool call within the window followed up, by lead type. Matched by shape, not by language.",
		kind: "objective",
		analyzers: ["uncompleted-leads"],
		measures: [
			{ kind: "total", id: "leads", metric: "uncompleted-leads.lead", field: "leads" },
			{ kind: "total", id: "uncompleted", metric: "uncompleted-leads.uncompleted-by-type", field: "uncompleted" },
			{ kind: "groups", id: "uncompletedByType", metric: "uncompleted-leads.uncompleted-by-type", dimensions: { leadType: LEAD_TYPES }, countField: "count" },
		],
	},
	async read(ctx) {
		const byType = Object.fromEntries(LEAD_TYPES.map((t) => [t, `$.uncompleted_by_type.${t}`]));
		const measured = await ctx.runs("uncompleted-leads", PAIRED_SINCE);
		const ran = new Set(measured);
		const rows = (await ctx.nodes("uncompleted-leads", { leads: "$.lead_count", uncompleted: "$.uncompleted_count", ...byType })).filter((r) => ran.has(String(r["session"])));
		const typed = rows.flatMap((r) => LEAD_TYPES.map((t) => ({ session: r["session"]!, leadType: t, count: r[t] ?? null })));
		return { measured, rows: [...rows.map((r) => ({ session: r["session"]!, leads: r["leads"]!, uncompleted: r["uncompleted"]! })), ...typed] };
	},
};
