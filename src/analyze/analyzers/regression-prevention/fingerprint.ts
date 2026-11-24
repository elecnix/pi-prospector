import type { FingerprintContributor } from "../../../fingerprint/contributor.js";
import { clusterVerdicts, countsAsRegression, DEFAULT_CONFIG, VERDICT_ANALYZER_ID, verdictFromNode } from "./aggregate.js";
import { TAXONOMY_SINCE } from "../regression-verdict/fingerprint.js";
import { CAUSE_CLASSES } from "../regression-verdict/questions.js";

/**
 * The regressions the prevention synthesis counts, and the kinds of mistake that
 * recur often enough for it to propose a change. Its own node describes the
 * whole corpus under one arbitrary session, so it ignores the fingerprint's
 * filter and fails the minimum group size. The section applies the analyzer's
 * rules to the verdicts in scope instead. A model judged those, so inferred.
 */
export const regressionPreventionFingerprint: FingerprintContributor = {
	def: {
		id: "regressionPrevention",
		label: "Regression prevention",
		description:
			"Regression verdicts at or above the synthesis's default confidence floor, by the kind of mistake as shares of them, and how many kinds recur often enough to be worth a proposal. Counts verdicts, not incidents. Computed from the verdicts in scope with the synthesis's default thresholds. The gate that admits a session to the model matches English phrasing. The cause and the prevention text are not published.",
		kind: "inferred",
		analyzers: [VERDICT_ANALYZER_ID],
		measures: [
			{ kind: "corpusCount", id: "regressionsCounted", metric: "regression-prevention.cause-class-recurrence", field: "counted", of: "regressions" },
			{ kind: "corpusGroups", id: "byCauseClass", metric: "regression-prevention.cause-class-recurrence", dimensions: { causeClass: [...CAUSE_CLASSES] }, total: "regressionsCounted", of: "regressions" },
			{ kind: "corpusCount", id: "recurringClasses", metric: "regression-prevention.cause-class-recurrence", field: "recurring", key: "causeClass", of: "cause classes" },
		],
	},
	async read(ctx) {
		const measured = new Set(await ctx.runs(VERDICT_ANALYZER_ID, TAXONOMY_SINCE));
		const nodes = await ctx.nodes(VERDICT_ANALYZER_ID, { fixes: "$.fixes_defect", regression: "$.is_regression", causeClass: "$.cause_class", confidence: "$.confidence" });
		const verdicts = nodes
			.filter((n) => measured.has(String(n["session"])))
			.flatMap((n) => {
				// A JSON true reads as 1.
				const verdict = verdictFromNode({ session_id: n["session"], fixes_defect: n["fixes"] === 1, is_regression: n["regression"] === 1, cause_class: n["causeClass"], confidence: n["confidence"] });
				return verdict !== null && countsAsRegression(verdict, DEFAULT_CONFIG) ? [verdict] : [];
			});
		const recurring = new Set(clusterVerdicts(verdicts).filter((c) => c.occurrences >= DEFAULT_CONFIG.minOccurrences && c.cause_class !== "unclassified").map((c) => c.cause_class));
		return {
			measured: [...measured],
			rows: verdicts.map((v) => ({ session: v.session_id, counted: 1, recurring: recurring.has(v.cause_class) ? 1 : 0, causeClass: v.cause_class })),
		};
	},
};
