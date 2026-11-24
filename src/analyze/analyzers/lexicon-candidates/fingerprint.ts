import type { FingerprintContributor } from "../../../fingerprint/contributor.js";

/**
 * How much the person typed and how varied the words are, as counts only. The
 * nominated words and phrases are never read: the reader takes three numbers
 * from each node. Counted, so objective.
 */
export const lexiconCandidatesFingerprint: FingerprintContributor = {
	def: {
		id: "vocabulary",
		label: "Vocabulary",
		description:
			"User-role messages read for the frustration lexicon, the words in them, and the distinct words per session. Code, paths, URLs and identifiers are dropped by shape, in any language. The user role also carries text the person pasted and text an agent or a harness wrote, so this is not only what the person typed. No word is published.",
		kind: "objective",
		analyzers: ["lexicon-candidates"],
		measures: [
			{ kind: "total", id: "messagesRead", metric: "lexicon-candidates.nominated-terms", field: "messages" },
			{ kind: "total", id: "words", metric: "lexicon-candidates.nominated-terms", field: "words" },
			{ kind: "distribution", id: "distinctWords", metric: "lexicon-candidates.nominated-terms", field: "distinct", unit: "words", edges: [0, 50, 150, 500, 1500, 5000] },
		],
	},
	async read(ctx) {
		const measured = new Set(await ctx.runs("lexicon-candidates"));
		const nodes = await ctx.nodes("lexicon-candidates", { messages: "$.user_message_count", words: "$.total_token_count", distinct: "$.distinct_token_count" });
		return { measured: [...measured], rows: nodes.filter((r) => measured.has(String(r["session"]))) };
	},
};
