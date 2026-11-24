import type { FingerprintContributor } from "../../../fingerprint/contributor.js";

/**
 * The first turn-pair-core version that reads message origin. An older version
 * found corrections in words an agent's brief or a harness notice carried, so a
 * session last run by one is not measured.
 */
export const ORIGIN_AWARE_SINCE = "1.3";

/** The kinds of correction the patterns tell apart. */
const CORRECTION_TYPES = ["explicit", "implicit", "repetition"];

/**
 * How often the person corrected or disputed the agent, found by matching
 * wording in each turn. Deterministic, so objective; the patterns are English.
 * The patterns, the matched text and the message ids stay out.
 */
export const turnPairCoreFingerprint: FingerprintContributor = {
	def: {
		id: "corrections",
		label: "Corrections",
		description:
			"Turns, the turns whose words corrected the agent (by type) or disputed what it said, and the high-signal turns that a correction, failed tool calls, an empty reply or oversized tool output marked. The correction and dispute patterns match English wording only, so a person who writes in another language shows fewer.",
		kind: "objective",
		analyzers: ["turn-pair-core"],
		measures: [
			{ kind: "total", id: "turns", metric: "turn-pair-core.friction-score", field: "turns" },
			{ kind: "total", id: "corrections", metric: "turn-pair-core.correction", field: "correction" },
			{ kind: "groups", id: "byCorrectionType", metric: "turn-pair-core.correction", dimensions: { correctionType: CORRECTION_TYPES } },
			{ kind: "total", id: "rebuttalCandidates", metric: "turn-pair-core.rebuttal-candidate", field: "rebuttal" },
			{ kind: "total", id: "highSignalTurns", metric: "turn-pair-core.friction-score", field: "highSignal" },
		],
	},
	async read(ctx) {
		const measured = new Set(await ctx.runs("turn-pair-core", ORIGIN_AWARE_SINCE));
		const pairs = await ctx.nodes("turn-pair-core", {
			correction: "$.correction_detected",
			correctionType: "$.correction_type",
			rebuttal: "$.rebuttal_candidate",
			highSignal: "$.high_signal",
		});
		return {
			measured: [...measured],
			rows: pairs.filter((r) => measured.has(String(r["session"]))).map((r) => ({ ...r, turns: 1 })),
		};
	},
};
