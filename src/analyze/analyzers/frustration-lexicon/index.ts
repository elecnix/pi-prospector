/**
 * frustration-lexicon — the learned, corpus-wide frustration vocabulary.
 *
 * This analyzer *is* the cache, and it needs no caching machinery to be one.
 *
 * A unit's source set is `[{ kind: "term", id: <word> }]` — the word and nothing
 * else. Since `input_key` folds in only the analyzer, its version, its config,
 * and that source set, the same word yields the same `input_key` in every
 * session; and since `analysis_nodes.input_key` is unique table-wide, the
 * framework's ordinary scan classifies an already-judged word as `current` and
 * skips it. The first session to nominate a word pays one cheap model call; every
 * later session in the corpus reuses the verdict for free, with no dictionary
 * table, no side state, and no cursor.
 *
 * Improving the judgement is an ordinary version bump: the source set is
 * unchanged, so the word's units go `stale`, and a run that asks for that reason
 * records the new verdict beside the old one with a `revises` edge — the lexicon
 * gets versioned lineage like everything else in the graph.
 */

import type {
	Analyzer,
	AnalyzerDef,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	AnalysisResult,
	AnalysisUnit,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeSourceSetHash, computeConfigHash } from "../../input-hash.js";
import { resolveModelSpec } from "../../model-tiers.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { LEXICON_CANDIDATES_DEF, type LexiconCandidatesProperties } from "../lexicon-candidates/index.js";
import {
	CLASSIFY_TERM_PROMPT,
	CLASSIFY_TERM_PROMPT_HASH,
	CLASSIFY_TERM_TOOL,
	buildClassifyTermPrompt,
	parseClassifyTermVerdict,
	extractVerdict,
} from "./prompt.js";
import { TERM_DECISION_QUESTIONS, TERM_DECISION_QUESTIONS_HASH, parseTermDecision } from "./decision.js";
import { decisionIdentity } from "../../decision-model.js";
import { DEFAULT_FRUSTRATION_LEXICON_CONFIG, DEFAULT_FRUSTRATION_LEXICON_MAX_TOKENS, type FrustrationLexiconConfig } from "./config.js";
import { Type, type Static } from "typebox";

/** The stored verdict for one term. */
export const FrustrationLexiconProperties = Type.Object({
	polarity: Type.String(),
	category: Type.String(),
	language: Type.String(),
	confidence: Type.Number(),
	rationale: Type.String(),
	/** The normalised term this verdict is about. */
	term: Type.String(),
	/** The decision model's distribution per field, when that path produced the verdict (#338). */
	probabilities: Type.Optional(Type.Record(Type.String(), Type.Record(Type.String(), Type.Number()))),
});
export type FrustrationLexiconProperties = Static<typeof FrustrationLexiconProperties>;

export const FRUSTRATION_LEXICON_DEF: AnalyzerDef = {
	id: "frustration-lexicon",
	label: "Frustration Lexicon (LLM, corpus-wide)",
	description:
		"Judges each previously unseen term nominated by a session — in any language, single word or two-word phrase — as a frustration signal, praise, or ordinary vocabulary, with a category and language. Keyed on the entry alone, so an entry is adjudicated once for the entire corpus and reused by every later session for free.",
	anchorSpan: "full_session",
	dependencies: [LEXICON_CANDIDATES_DEF.id],
	outputSchema: FrustrationLexiconProperties,
};

export const FRUSTRATION_LEXICON_VERSION: AnalyzerVersion = {
	analyzerId: FRUSTRATION_LEXICON_DEF.id,
	major: 1,
	// 1.1: the prompt now also covers two-word phrases (issue #40), judged as a
	// unit rather than as their parts.
	// 1.3: phrases removed. At corpus scale they were 84% of adjudications and 75%
	// of hits while being overwhelmingly noise; adjacent words in running prose are
	// not idioms. Single-word judgement is what actually works. See #40.
	// 1.2: precision. Measured against a real corpus, cheap models flagged `ci`,
	// `pr`, `gh`, `sh` and 🔀 as frustration — 10.7% of vocabulary called
	// non-neutral against a 3.8% reference. Two unrelated cheap models failing the
	// same way pointed at the prompt, not the model: it never said that naming a
	// tool or reporting a status is not a feeling. Existing verdicts stay valid and
	// are re-judged only by an explicit `--revise minor`.
	// 1.4: precision, round two. Weighted by hits rather than sampled, the top
	// signals over a real corpus were ~38% noise: `but` x1270, `pushed` x887,
	// `already` x849, `same` x787, `without` x723, `false` x687, `stopped` x452 —
	// ordinary grammar and reporting verbs. The prompt now separates instructions
	// from reports ("stop" vs "stopped") and approval from outcome ("thanks" vs
	// "successfully"), which the earlier tool-name rule did not reach.
	// 1.5: a deterministic function-word guard (issue #321). The prompt wording
	// above did not hold: a cheap model asked about a bare `no` still answered
	// "frustration" / "negation", and since a verdict is cached corpus-wide and
	// permanently, the top-ranked frustration terms on a real corpus became `do`
	// (254 hits), `no` (191), `do not` (172), `never` (152), `cannot` (129) and
	// `still` (90) — ordinary instruction words that appear in nearly every
	// prompt. Superseded by 1.6.
	// 1.6: the guard is gone (issue #321). A hand-written list of English function
	// words fixed an English symptom: it could not reach any other language, and
	// it decided by spelling a property the corpus measures for itself. The terms
	// above were not noise because they are English, but because a large share of
	// turns carry them — and that share is measurable for `do`, `putain`, and
	// `まだ` alike. The verdict now records exactly what the model judged; the
	// readers price a term by its document share (`term-specificity.ts`). The prompt
	// is unchanged — it always asked the model to judge meaning, and the guard was
	// applied to the parsed answer — so a verdict cached under the guard keeps its
	// stored polarity and is simply no longer overridden on the way out.
	// 1.7: an `insult` category, apart from profanity. An insult names or demeans
	// the assistant or its work ("idiot", "moron"); profanity is swearing that names
	// no one. Before, both landed under profanity, so insults aimed at the assistant
	// could not be counted on their own. Only a verdict filed under profanity can
	// move, so re-judge just those with `--revise minor --revise-where
	// category=profanity`; every other verdict stays valid and stale.
	minor: 7,
	implementationKind: "in_process_llm",
	codeRef: "src/analyze/analyzers/frustration-lexicon/index.ts",
};

const PROMPTS: Record<string, PromptVersion> = {
	classify_term: { hash: CLASSIFY_TERM_PROMPT_HASH, content: CLASSIFY_TERM_PROMPT, role: "classify_term" },
};

/** The stored verdict for one term. */

interface TermMeta {
	term: string;
}

export const frustrationLexiconAnalyzer: Analyzer = {
	def: FRUSTRATION_LEXICON_DEF,
	version: FRUSTRATION_LEXICON_VERSION,
	prompts: PROMPTS,
	defaultConfig: {
		id: "",
		analyzerId: FRUSTRATION_LEXICON_DEF.id,
		configHash: computeConfigHash(DEFAULT_FRUSTRATION_LEXICON_CONFIG),
		configJson: DEFAULT_FRUSTRATION_LEXICON_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	modelsForIdentity(config, modelTiers): string[] {
		const cfg = (config as unknown as FrustrationLexiconConfig) ?? DEFAULT_FRUSTRATION_LEXICON_CONFIG;
		// No adjudication means no model to resolve, so a dictionary-only setup
		// needs no credentials for this analyzer.
		if (cfg.adjudicate === false) return [];
		if (cfg.decisionModel) return [decisionIdentity(cfg.decisionModel, TERM_DECISION_QUESTIONS_HASH)];
		return [resolveModelSpec(cfg.tier, modelTiers)];
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		// `lexicon.mode: "dictionary"`: the user's dictionary replaces the learned
		// lexicon, so nothing is judged and no model is called.
		if ((ctx.config as unknown as FrustrationLexiconConfig | undefined)?.adjudicate === false) return [];

		// This session's nominations, kept in the frequency order nomination chose.
		// Nodes are read in a fixed order and a duplicate keeps its first position, so
		// this list is reproducible.
		const nominatedTerms: string[] = [];
		const seen = new Set<string>();
		const candidateNodes = [...(ctx.dependencyNodes[LEXICON_CANDIDATES_DEF.id] ?? [])].sort((a, b) =>
			a.output_key < b.output_key ? -1 : a.output_key > b.output_key ? 1 : 0,
		);
		for (const node of candidateNodes) {
			let props: LexiconCandidatesProperties;
			try {
				props = JSON.parse(node.content_json) as LexiconCandidatesProperties;
			} catch {
				continue;
			}
			// Phrases ride the exact same path as words: a phrase is just a longer
			// corpus-wide entry, its source ref is still `term`-kind with the
			// space-joined normalised form as the id, and it inherits this analyzer's
			// cache, lineage, and prompt envelope unchanged. That is why nomination's
			// change carries the whole version burden (#40): nothing in *this*
			// analyzer's identity inputs — prompt, config, source-ref shape — moved,
			// so it needs no bump of its own.
			for (const t of props.terms ?? []) {
				if (!seen.has(t.term)) { seen.add(t.term); nominatedTerms.push(t.term); }
			}
			for (const t of props.phrases ?? []) {
				if (!seen.has(t.term)) { seen.add(t.term); nominatedTerms.push(t.term); }
			}
		}

		// Every nominated entry is planned, with no per-session budget applied here.
		//
		// A budget over *unjudged* entries is the tempting design — it would let each
		// session's allowance reach vocabulary the corpus has never seen, instead of
		// being consumed by the same common words every time. It is also wrong: it
		// makes planning a function of graph state, so each re-run frees the slots the
		// previous run filled and buys another batch. Measured, a single session kept
		// judging 60 more entries on every pass, forever — a direct violation of "re-
		// running without changing version, config, or inputs produces no new nodes".
		//
		// No budget is needed, because the cost it was guarding against self-limits.
		// An entry the corpus has already judged is free — the scan classifies it
		// `current` and skips it — so a session only ever pays for vocabulary no
		// earlier session used. The total spend across the whole corpus is therefore
		// bounded by the corpus's distinct vocabulary, once, no matter how the caps
		// are set. The ceilings in lexicon-candidates bound node size, not spend.
		const planned = nominatedTerms;

		return planned.map((term): AnalysisUnit => {
			const sources: SourceRef[] = [{ kind: "term", id: term }];
			return {
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
				meta: { term } satisfies TermMeta as unknown as Record<string, unknown>,
			};
		});
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = (ctx.config.configJson as unknown as FrustrationLexiconConfig) ?? DEFAULT_FRUSTRATION_LEXICON_CONFIG;
		const { term } = unit.meta as unknown as TermMeta;

		if (config.decisionModel) {
			if (!ctx.decide) {
				throw new Error(`frustration-lexicon is configured with decision model '${config.decisionModel}', but this run has no decision-model client.`);
			}
			// The term is the whole state, so the verdict stays a function of the term alone.
			const decision = await ctx.decide({ model: config.decisionModel, state: { term }, questions: TERM_DECISION_QUESTIONS });
			const properties: FrustrationLexiconProperties = { ...parseTermDecision(decision), term };
			return {
				nodeKind: "classification",
				contentJson: properties as unknown as Record<string, unknown>,
				anchorKind: "session",
				anchorRef: unit.anchorRef,
				modelUsed: decision.model,
				costUsd: decision.costUsd,
				tokensUsed: decision.inputTokens + decision.outputTokens,
				inputTokens: decision.inputTokens,
				cachedInputTokens: 0,
				outputTokens: decision.outputTokens,
				durationMs: decision.durationMs,
				edges: [{ toRefKind: REF_KINDS.SESSION, toRefId: unit.anchorRef, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 }],
			};
		}

		const response = await ctx.llm({
			model: resolveModelSpec(config.tier, ctx.modelTiers),
			system: ctx.prompts["classify_term"] ?? CLASSIFY_TERM_PROMPT,
			user: buildClassifyTermPrompt(term),
			temperature: config.temperature,
			// Room for the verdict and its rationale — see the budget's note in config.ts.
			maxTokens: config.maxTokens ?? DEFAULT_FRUSTRATION_LEXICON_MAX_TOKENS,
			reasoning: config.reasoning,
			tool: CLASSIFY_TERM_TOOL,
		});

		// A verdict is cached *permanently* and corpus-wide, so an invented one is far
		// worse here than a failure. Quietly defaulting an unusable reply to "neutral"
		// would let a model that cannot do structured output mark every word in the
		// corpus as ordinary vocabulary: the feature would appear to run and do
		// nothing, with no way to tell from the outside. Failing instead records an
		// error node, leaves the unit missing, and self-heals on the next run.
		//
		// The tool call is preferred; JSON in the text channel is accepted, since some
		// providers answer that way. What is rejected is a reply that carries no
		// verdict at all — this checks for the shape, not merely for parseable JSON,
		// because a well-formed object of the wrong kind would otherwise degrade
		// silently into the same all-neutral lexicon.
		const verdict = extractVerdict(response.structured, response.text);
		if (!verdict) {
			throw new Error(
				`Model '${response.model}' returned no usable classify_term verdict for '${term}'. ` +
				`A lexicon verdict is cached corpus-wide and permanently, so it is never guessed. ` +
				`Use a model that supports forced tool calls.`,
			);
		}

		const properties: FrustrationLexiconProperties = { ...parseClassifyTermVerdict(term, verdict), term };

		return {
			nodeKind: "classification",
			contentJson: properties as unknown as Record<string, unknown>,
			// The verdict is corpus-wide, but it links back to the session that
			// triggered it — that session paid for the call and is where the word was
			// first seen. Note there is deliberately no `consumes` edge to the
			// nomination node: that node is session-specific and must not enter a
			// corpus-wide term's provenance.
			anchorKind: "session",
			anchorRef: unit.anchorRef,
			modelUsed: response.model,
			costUsd: response.costUsd,
			tokensUsed: response.tokensUsed,
			inputTokens: response.inputTokens,
			cachedInputTokens: response.cachedInputTokens,
			outputTokens: response.outputTokens,
			durationMs: response.durationMs,
			edges: [
				{ toRefKind: REF_KINDS.SESSION, toRefId: unit.anchorRef, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
				{ toRefKind: REF_KINDS.PROMPT_VERSION, toRefId: CLASSIFY_TERM_PROMPT_HASH, edgeKind: EDGE_KINDS.USES_PROMPT, ordinal: 1 },
			],
		};
	},
};
