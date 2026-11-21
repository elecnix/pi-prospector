import type { FingerprintContributor, FingerprintRow } from "../../../fingerprint/contributor.js";

/** Score buckets in percent: the last one holds the sessions that scored 100. */
const EDGES = [0, 25, 50, 75, 100];

const SCORES = { compliance: "$.pc", phasesPresent: "$.ppc", orderKept: "$.poc", phaseFidelity: "$.ppf" } as const;

/**
 * How closely sessions follow navigate, reproduce, patch, validate: the four
 * LivePlan scores of each session, in percent. The scores are pure functions
 * of phase-trajectory's phases, so the figures are objective.
 */
export const planComplianceFingerprint: FingerprintContributor = {
	def: {
		id: "planCompliance",
		label: "Plan compliance",
		description:
			"Per session, in percent: the plan phases present, the transitions in canonical order, the turns spent in a plan phase, and their geometric mean. A ranking feature, not an outcome. Read from tool names and commands, not from language.",
		kind: "objective",
		analyzers: ["plan-compliance"],
		measures: [
			{ kind: "distribution", id: "compliance", metric: "plan-compliance.plan-compliance", field: "compliance", unit: "percent", edges: EDGES },
			{ kind: "distribution", id: "phasesPresent", metric: "plan-compliance.plan-phase-compliance", field: "phasesPresent", unit: "percent", edges: EDGES },
			{ kind: "distribution", id: "orderKept", metric: "plan-compliance.plan-order-compliance", field: "orderKept", unit: "percent", edges: EDGES },
			{ kind: "distribution", id: "phaseFidelity", metric: "plan-compliance.plan-phase-fidelity", field: "phaseFidelity", unit: "percent", edges: EDGES },
		],
	},
	async read(ctx) {
		const ran = new Set(await ctx.runs("plan-compliance"));
		const rows = (await ctx.nodes("plan-compliance", SCORES)).filter((r) => ran.has(String(r["session"])));
		const percent = (v: FingerprintRow[string]) => (typeof v === "number" ? Math.round(v * 10_000) / 100 : null);
		// A session the analyzer ran on with no node has no score: it is not a zero.
		const scored = new Set(rows.map((r) => String(r["session"])));
		return {
			measured: [...ran].filter((id) => scored.has(id)),
			rows: rows.map((r) => ({ session: r["session"]!, ...Object.fromEntries(Object.keys(SCORES).map((k) => [k, percent(r[k] ?? null)])) })),
		};
	},
};
