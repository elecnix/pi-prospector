/**
 * lexicon-candidates — deterministic vocabulary nomination.
 *
 * The first stage of the learned frustration lexicon. For each session it
 * tokenises the user's own words and nominates the terms worth adjudicating,
 * producing one `metric` node per session. No LLM, no dependencies.
 *
 * Nomination is deliberately language-blind: there is no stopword list and no
 * stemming, only a shape filter that drops code, paths, and identifiers. Which
 * of these words actually signals frustration is not decided here — that is the
 * `frustration-lexicon` analyzer's job, and it asks a model once per word for the
 * whole corpus.
 */

import type {
	Analyzer,
	AnalyzerDef,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	AnalysisResult,
	AnalysisUnit,
	MessageRow,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeSourceSetHash, computeConfigHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { rankTerms, rankPhrases, tokenize, TermCount } from "./tokenize.js";
import { DEFAULT_LEXICON_CANDIDATES_CONFIG, type LexiconCandidatesConfig } from "./config.js";
import { Type, type Static } from "typebox";

export const LexiconCandidatesProperties = Type.Object({
	/** Nominated single terms, most frequent first. */
	terms: Type.Array(TermCount),
	/**
	 * Nominated two-word phrases (adjacent tokens within one sentence segment),
	 * most frequent first, under their own cap. A phrase is judged as a unit by
	 * `frustration-lexicon`, keyed on its space-joined normalised form.
	 */
	phrases: Type.Array(TermCount),
	/** How many user messages were read. */
	user_message_count: Type.Number(),
	/** Distinct tokens seen before the cap was applied. */
	distinct_token_count: Type.Number(),
	/** Total token occurrences, for a sense of how much text backed the nomination. */
	total_token_count: Type.Number(),
});
export type LexiconCandidatesProperties = Static<typeof LexiconCandidatesProperties>;

export const LEXICON_CANDIDATES_DEF: AnalyzerDef = {
	id: "lexicon-candidates",
	label: "Lexicon Candidates (deterministic)",
	description:
		"Tokenises a session's user messages and nominates the distinct terms worth adjudicating for the frustration lexicon, ranked by frequency and capped per session: single words without limit in practice, plus two-word phrases from adjacent tokens within a sentence under their own tighter cap. Language-blind: no stopwords, no stemming, only a shape filter that drops code, paths, and identifiers. No LLM.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: LexiconCandidatesProperties,
};

export const LEXICON_CANDIDATES_VERSION: AnalyzerVersion = {
	analyzerId: LEXICON_CANDIDATES_DEF.id,
	major: 1,
	// 1.1: also nominated two-word phrases (issue #40).
	// 1.2: phrases removed. Measured over the real corpus they were 84% of all
	// adjudications and 75% of all hits while being overwhelmingly noise — adjacent
	// words in running prose are simply not idioms. See #40.
	// 1.3: hyphenated compounds are kept whole. Splitting them nominated bare
	// prefixes, and `re` and `non` were duly judged as frustration and fired 1,110
	// times between them over a real corpus.
	// 1.4: phrases return, conservatively (issue #40). Adjacent bigrams within a
	// sentence segment are nominated again — but ranked by frequency and capped
	// per session (`maxPhrasesPerSession`, default 50) so the permanent corpus-wide
	// verdict cache is spent on repeated candidates rather than flooded with junk,
	// which is what sank 1.2's predecessor. Trigrams stay out; see the TODO in
	// tokenize.ts.
	minor: 4,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/lexicon-candidates/index.ts",
};

/** Roles whose text counts as the user's own words. */
const USER_ROLES = new Set<string>(["user", "custom_message"]);

/** The user-authored messages of a session, in order. */
export function userMessages(messages: readonly MessageRow[]): MessageRow[] {
	return messages.filter((m) => USER_ROLES.has(m.role) && (m.content_text ?? "").trim().length > 0);
}

export const lexiconCandidatesAnalyzer: Analyzer = {
	def: LEXICON_CANDIDATES_DEF,
	version: LEXICON_CANDIDATES_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: LEXICON_CANDIDATES_DEF.id,
		configHash: computeConfigHash(DEFAULT_LEXICON_CANDIDATES_CONFIG),
		configJson: DEFAULT_LEXICON_CANDIDATES_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		const users = userMessages(ctx.messages);
		if (users.length === 0) return [];

		// The source set is the user messages themselves, so nomination re-runs only
		// when the session's user text changes.
		const sources: SourceRef[] = users.map((m) => ({ kind: "message" as const, id: m.id }));
		return [
			{
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
				meta: { texts: users.map((m) => m.content_text ?? "") },
			},
		];
	},

	analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): AnalysisResult {
		const config = (ctx.config.configJson as unknown as LexiconCandidatesConfig) ?? DEFAULT_LEXICON_CANDIDATES_CONFIG;
		const texts = (unit.meta?.["texts"] as string[] | undefined) ?? [];

		const allTokens = texts.flatMap((t) => tokenize(t));
		const properties: LexiconCandidatesProperties = {
			terms: rankTerms(texts, config.maxTermsPerSession),
			phrases: rankPhrases(texts, config.maxPhrasesPerSession),
			user_message_count: texts.length,
			distinct_token_count: new Set(allTokens).size,
			total_token_count: allTokens.length,
		};

		return {
			nodeKind: "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: unit.anchorRef,
			edges: [
				{ toRefKind: REF_KINDS.SESSION, toRefId: unit.anchorRef, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
			],
		};
	},
};
