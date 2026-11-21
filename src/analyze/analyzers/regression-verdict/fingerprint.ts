import type { FingerprintContributor } from "../../../fingerprint/contributor.js";
import { newestPerSession } from "../../../fingerprint/latest-node.js";
import { CAUSE_CLASSES, PREVENTION_CLASSES } from "./questions.js";

/**
 * The first regression-verdict version with the split cause taxonomy. A
 * session last judged by 1.0 has its regression in a class 1.1 broke into
 * three, so its counts per class do not compare and it is not measured.
 */
export const TAXONOMY_SINCE = "1.1";

/**
 * What the model judged about the sessions the gate admitted: how many repaired
 * a defect, how many of those were regressions, and the kind of mistake and of
 * prevention, from the analyzer's closed sets. The cause, the prevention prose
 * and the evidence quote are never read. A model judged them, so inferred.
 */
export const regressionVerdictFingerprintContributor: FingerprintContributor = {
	def: {
		id: "regressions",
		label: "Regressions",
		description:
			"Sessions a model judged, those that repaired a defect, and the regressions among them by kind of mistake, by the change that would have prevented it, and by how far the evidence states the cause. The gate that admits a session to the model matches English phrasing, so a session written in another language is judged less often.",
		kind: "inferred",
		analyzers: ["regression-verdict"],
		measures: [
			{ kind: "total", id: "judged", metric: "regression-verdict.verdict", field: "judged" },
			{ kind: "sessions", id: "defectFixes", metric: "regression-verdict.verdict", field: "fixes" },
			{ kind: "sessions", id: "regressions", metric: "regression-verdict.verdict", field: "regression" },
			{ kind: "groups", id: "byCauseClass", metric: "regression-verdict.verdict", dimensions: { causeClass: [...CAUSE_CLASSES] } },
			{ kind: "groups", id: "byPreventionClass", metric: "regression-verdict.verdict", dimensions: { preventionClass: [...PREVENTION_CLASSES] } },
			{ kind: "groups", id: "byProvenance", metric: "regression-verdict.verdict", dimensions: { provenance: ["stated", "inferred", "unstated"] } },
		],
	},
	async read(ctx) {
		const measured = new Set(await ctx.runs("regression-verdict", TAXONOMY_SINCE));
		const nodes = await ctx.nodes("regression-verdict", {
			fixes: "$.fixes_defect",
			regression: "$.is_regression",
			causeClass: "$.cause_class",
			preventionClass: "$.prevention_class",
			provenance: "$.cause_provenance",
		});
		const verdicts = newestPerSession(nodes.filter((r) => measured.has(String(r["session"])) && typeof r["regression"] === "number"));
		return {
			measured: [...measured],
			rows: verdicts.map((r) => {
				const regression = r["regression"] === 1;
				return {
					session: r["session"]!,
					judged: 1,
					fixes: r["fixes"] ?? null,
					regression: regression ? 1 : 0,
					// Only a regression has a kind of mistake; a defect that never worked is `unclassified` by rule.
					causeClass: regression ? r["causeClass"]! : null,
					preventionClass: regression ? r["preventionClass"]! : null,
					provenance: regression ? r["provenance"]! : null,
				};
			}),
		};
	},
};
