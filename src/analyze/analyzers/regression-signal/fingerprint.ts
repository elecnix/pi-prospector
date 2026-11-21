import type { FingerprintContributor } from "../../../fingerprint/contributor.js";

/**
 * The first regression-signal version whose claim does not require a named
 * cause. 1.0 claimed only when the session named a pull request or commit, so
 * a session it last read would undercount: it is not measured.
 */
export const CLAIM_SINCE = "1.1";

/**
 * Sessions that state they repaired a defect an earlier change caused, read
 * from the transcript's own words. Deterministic, so objective. The citations,
 * which name repositories and quote the session, are never read.
 */
export const regressionSignalFingerprintContributor: FingerprintContributor = {
	def: {
		id: "regressionClaims",
		label: "Regression claims",
		description:
			"Sessions that changed something and state the defect came from an earlier change, those that name the change, and those that reverted. Detection matches English phrasing, so a session written in another language reads as no claim.",
		kind: "objective",
		analyzers: ["regression-signal"],
		measures: [
			{ kind: "sessions", id: "claims", metric: "regression-signal.regression-claim", field: "claim" },
			{ kind: "sessions", id: "namedCause", metric: "regression-signal.regression-claim", field: "named" },
			{ kind: "sessions", id: "reverts", metric: "regression-signal.regression-claim", field: "reverts" },
		],
	},
	async read(ctx) {
		const measured = new Set(await ctx.runs("regression-signal", CLAIM_SINCE));
		const nodes = await ctx.nodes("regression-signal", { claim: "$.claims_regression", named: "$.signals.names_the_cause", reverts: "$.signals.reverts" });
		return {
			measured: [...measured],
			rows: nodes.filter((r) => measured.has(String(r["session"]))).map((r) => {
				// A node whose claim fell away is kept by the graph and counts as no claim here.
				const claim = r["claim"] === 1 ? 1 : 0;
				return { session: r["session"]!, claim, named: claim * (r["named"] === 1 ? 1 : 0), reverts: claim * (r["reverts"] === 1 ? 1 : 0) };
			}),
		};
	},
};
