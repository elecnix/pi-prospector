import type { FingerprintContributor } from "../../../fingerprint/contributor.js";

/** What a judged proposal's rule is. `unchecked` is the default of a proposal nobody judged, and no node carries it. */
const STATUSES = ["gap", "partial", "restated", "ungrounded"];

/**
 * Whether the rules a person's proposals suggest were already in the instruction
 * files. The proposal, the rule, its quote and its path are never read. A model
 * judged each, so inferred.
 */
export const ruleRestatementFingerprint: FingerprintContributor = {
	def: {
		id: "ruleRestatement",
		label: "Rule restatement",
		description:
			"Rule-shaped proposals a model compared with the instruction files on disk: the rule is missing (gap), partly there, already there (restated: it exists and was not followed), or claimed without a quote that checks out (ungrounded). Only proposals still open when the analyzer ran are judged, so the counts follow how a person reviews proposals, and the files are read as they were on that day. No rule text is published.",
		kind: "inferred",
		analyzers: ["rule-restatement"],
		measures: [
			{ kind: "corpusCount", id: "proposalsJudged", metric: "rule-restatement.rule-status", field: "judged", of: "proposals" },
			{ kind: "corpusGroups", id: "byStatus", metric: "rule-restatement.rule-status", dimensions: { status: STATUSES }, total: "proposalsJudged", of: "proposals" },
		],
	},
	async read(ctx) {
		const verdicts = await ctx.nodes("rule-restatement", { status: "$.rule_status" });
		return { measured: verdicts.map((v) => String(v["session"])), rows: verdicts.map((v) => ({ ...v, judged: 1 })) };
	},
};
