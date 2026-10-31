import type { FingerprintContributor } from "../../../fingerprint/contributor.js";

/**
 * What the classifier judged about the turns it read. It reads only the turns
 * that looked high-signal, so these describe those turns and not the whole
 * corpus. A model judged them, so the figures are inferred.
 */
export const turnPairLlmFingerprint: FingerprintContributor = {
	def: {
		id: "turnClassification",
		label: "Turn classification",
		description: "Friction type and sentiment of the turns the classifier judged.",
		kind: "inferred",
		measures: [
			{ kind: "total", id: "turnsClassified", field: "turns" },
			{
				kind: "groups",
				id: "frictionType",
				dimensions: { frictionType: ["none", "wrong_approach", "missed_instruction", "tool_misuse", "repetition", "rebuttal"] },
			},
			{ kind: "groups", id: "sentiment", dimensions: { sentiment: ["positive", "neutral", "frustrated"] } },
		],
	},
	async read(ctx) {
		const measured = await ctx.runs("turn-pair-llm");
		const judged = await ctx.nodes("turn-pair-llm", { sentiment: "$.sentiment", frictionType: "$.friction_type" });
		return { measured, rows: judged.map((r) => ({ ...r, turns: 1 })) };
	},
};
