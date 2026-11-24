import type { FingerprintContributor } from "../../../fingerprint/contributor.js";
import { TERM_DECISION_QUESTIONS, TERM_LANGUAGES } from "./decision.js";

const optionsOf = (question: string) => Object.keys((TERM_DECISION_QUESTIONS[question] as { criteria: Record<string, unknown> }).criteria);

const POLARITIES = optionsOf("polarity");
/** The categories of a signal. `none` is a signal the model filed under no category. */
const CATEGORIES = optionsOf("category");
/** The language codes a fingerprint may name; any other code counts as `other`. */
const LANGUAGES = [...Object.keys(TERM_LANGUAGES), "und"];

/**
 * The learned lexicon as counts: how many terms were judged, and how they split
 * by polarity, by category and by language. The terms never leave the machine,
 * and the reader does not select them. A model judged each, so inferred.
 *
 * A term is judged once for the whole corpus and belongs to the session that
 * first used it, so these are counts over the corpus and not per session.
 */
export const frustrationLexiconFingerprint: FingerprintContributor = {
	def: {
		id: "lexicon",
		label: "Learned lexicon",
		description:
			"Distinct words and phrases a model judged for the frustration lexicon, once for the whole corpus: by polarity and by language as shares of the terms judged, and by category as shares of the signal terms (frustration or praise). A term counts in the session that first used it, so a filtered fingerprint, or a term first used in a sub-agent's session, leaves it out. The sessions measured are those that added a term, not those whose words were judged. A category carries the version that judged it: before 1.7 insults were filed under profanity. No term is published.",
		kind: "inferred",
		analyzers: ["frustration-lexicon"],
		measures: [
			{ kind: "corpusCount", id: "termsJudged", metric: "frustration-lexicon.lexicon-verdict", field: "judged", of: "terms" },
			{ kind: "corpusCount", id: "signalTerms", metric: "frustration-lexicon.lexicon-verdict", field: "signal", of: "terms" },
			{ kind: "corpusGroups", id: "byPolarity", metric: "frustration-lexicon.lexicon-verdict", dimensions: { polarity: POLARITIES }, total: "termsJudged", of: "terms" },
			{ kind: "corpusGroups", id: "byLanguage", metric: "frustration-lexicon.lexicon-verdict", dimensions: { language: LANGUAGES }, total: "termsJudged", of: "terms" },
			{ kind: "corpusGroups", id: "byCategory", metric: "frustration-lexicon.lexicon-verdict", dimensions: { category: CATEGORIES }, total: "signalTerms", of: "terms" },
		],
	},
	async read(ctx) {
		const verdicts = await ctx.nodes("frustration-lexicon", { polarity: "$.polarity", category: "$.category", language: "$.language" });
		// A dictionary-only setup runs the analyzer and judges nothing, so a run is no evidence of a verdict.
		return {
			measured: verdicts.map((v) => String(v["session"])),
			rows: verdicts.map((v) => {
				const signal = v["polarity"] !== "neutral" ? 1 : 0;
				return { ...v, judged: 1, signal, category: signal === 1 ? v["category"]! : null };
			}),
		};
	},
};
