import type { FingerprintContributor } from "../../../fingerprint/contributor.js";

/** The categories of a frustration signal: the lexicon's closed set, and the wordless markers. */
const CATEGORIES = ["profanity", "insult", "negation", "correction", "repetition", "urgency", "confusion", "dissatisfaction", "praise", "paralinguistic"];

/**
 * Frustration signals in text the person typed. Matching is deterministic but a
 * model judged each word, so the figures are inferred. A hit with no origin
 * label cannot be told from pasted text and counts for nothing.
 */
export const turnFrustrationFingerprint: FingerprintContributor = {
	def: {
		id: "frustration",
		label: "Frustration",
		description: "Frustration signals the person typed, by category.",
		kind: "inferred",
		measures: [
			{ kind: "total", id: "signals", field: "typed" },
			{ kind: "groups", id: "byCategory", dimensions: { category: CATEGORIES }, countField: "typed" },
		],
	},
	async read(ctx) {
		const measured = await ctx.runs("turn-frustration");
		const hits = await ctx.nodes("turn-frustration", { source: "$.signal_source", category: "$.category", typed: "$.origins.typed" });
		return {
			measured,
			rows: hits.map((h) => ({ session: h["session"]!, category: h["source"] === "paralinguistic" ? "paralinguistic" : h["category"]!, typed: h["typed"]! })),
		};
	},
};
