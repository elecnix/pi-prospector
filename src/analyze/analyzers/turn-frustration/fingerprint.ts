import type { FingerprintContributor } from "../../../fingerprint/contributor.js";

/** The categories of a frustration signal: the lexicon's closed set, and the wordless markers. */
const CATEGORIES = ["profanity", "insult", "negation", "correction", "repetition", "urgency", "confusion", "dissatisfaction", "praise", "paralinguistic"];

/**
 * The first turn-frustration version that labels the origin of each hit and
 * writes `typed_count`. A session last run by an older version is not measured:
 * its hits cannot be told from pasted text, and reading them as zero typed
 * signals would report a false 0.
 */
export const LABELLED_SINCE = "1.10";

/**
 * Frustration signals in text the person typed. Matching is deterministic but a
 * model judged each word, so the figures are inferred. Only sessions whose
 * latest run labelled origins are measured, and a session that still carries a
 * hit without the label (drawn before the re-run) is left out too.
 */
export const turnFrustrationFingerprint: FingerprintContributor = {
	def: {
		id: "frustration",
		label: "Frustration",
		description: "Frustration signals the person typed, by category.",
		kind: "inferred",
		analyzers: ["turn-frustration"],
		measures: [
			{ kind: "total", id: "signals", metric: "turn-frustration.frustration-signal", field: "typed" },
			{ kind: "groups", id: "byCategory", metric: "turn-frustration.frustration-signal", dimensions: { category: CATEGORIES }, countField: "typed" },
		],
	},
	async read(ctx) {
		const labelled = new Set(await ctx.runs("turn-frustration", LABELLED_SINCE));
		const hits = await ctx.nodes("turn-frustration", { source: "$.signal_source", category: "$.category", typed: "$.typed_count" });
		for (const h of hits) if (typeof h["typed"] !== "number") labelled.delete(String(h["session"]));
		return {
			measured: [...labelled],
			rows: hits
				.filter((h) => labelled.has(String(h["session"])))
				.map((h) => ({ session: h["session"]!, category: h["source"] === "paralinguistic" ? "paralinguistic" : h["category"]!, typed: h["typed"]! })),
		};
	},
};
