import type { FingerprintContributor } from "../../../fingerprint/contributor.js";

/** The routing verdicts of a turn: routing-opportunity's closed set. */
const VERDICTS = ["downshift", "escalate", "neutral"];

/**
 * The first version whose frustration feature counts only the words the person
 * typed. An older run counted pasted text as frustration and so escalated turns
 * it should not have; its verdicts mean something else and are not measured.
 */
export const TYPED_FRUSTRATION_SINCE = "1.4";

/**
 * Which turns a cheaper model would probably have served, and what they cost.
 * The rules are deterministic, so objective, but they read English correction
 * and frustration wording. The serving model stays out: a model id names a
 * person's setup.
 */
export const routingOpportunityFingerprint: FingerprintContributor = {
	def: {
		id: "routing",
		label: "Routing opportunity",
		description:
			"Turns labelled downshift (a cheaper model would probably have served), escalate (the turn struggled) or neutral, and the billed cost of all turns and of the downshift turns. The labels read correction and frustration wording that matches English only.",
		kind: "objective",
		analyzers: ["routing-opportunity"],
		measures: [
			{ kind: "groups", id: "turnsByVerdict", metric: "routing-opportunity.routing-verdict", dimensions: { verdict: VERDICTS } },
			{ kind: "total", id: "turnCostUsd", metric: "routing-opportunity.turn-cost", field: "cost", decimals: 2 },
			{ kind: "total", id: "downshiftCostUsd", metric: "routing-opportunity.turn-cost", field: "downshiftCost", decimals: 2 },
		],
	},
	async read(ctx) {
		const measured = new Set(await ctx.runs("routing-opportunity", TYPED_FRUSTRATION_SINCE));
		const turns = (await ctx.nodes("routing-opportunity", { verdict: "$.verdict", cost: "$.turn_cost_usd" })).filter((t) => measured.has(String(t["session"])));
		return {
			measured: [...measured],
			rows: turns.map((t) => ({ session: t["session"]!, verdict: t["verdict"] ?? null, cost: t["cost"] ?? null, downshiftCost: t["verdict"] === "downshift" ? (t["cost"] ?? null) : null })),
		};
	},
};
