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
	parseClassifyTermObject,
	type ClassifyTermResult,
} from "./prompt.js";
import { DEFAULT_FRUSTRATION_LEXICON_CONFIG, type FrustrationLexiconConfig } from "./config.js";

export const FRUSTRATION_LEXICON_DEF: AnalyzerDef = {
	id: "frustration-lexicon",
	label: "Frustration Lexicon (LLM, corpus-wide)",
	description:
		"Judges each previously unseen term or two-word phrase nominated by a session — in any language — as a frustration signal, praise, or ordinary vocabulary, with a category and language. Keyed on the term alone, so a word is adjudicated once for the entire corpus and reused by every later session for free.",
	anchorSpan: "full_session",
	dependencies: [LEXICON_CANDIDATES_DEF.id],
};

export const FRUSTRATION_LEXICON_VERSION: AnalyzerVersion = {
	analyzerId: FRUSTRATION_LEXICON_DEF.id,
	major: 1,
	// 1.1: the prompt now also covers two-word phrases (issue #40), judged as a
	// unit rather than as their parts. Existing single-word verdicts stay valid and
	// are only re-judged by an explicit `--revise minor`; nothing is invalidated by
	// simply upgrading.
	minor: 1,
	implementationKind: "in_process_llm",
	codeRef: "src/analyze/analyzers/frustration-lexicon/index.ts",
};

const PROMPTS: Record<string, PromptVersion> = {
	classify_term: { hash: CLASSIFY_TERM_PROMPT_HASH, content: CLASSIFY_TERM_PROMPT, role: "classify_term" },
};

/** The stored verdict for one term. */
export interface FrustrationLexiconProperties extends ClassifyTermResult {
	/** The normalised term this verdict is about. */
	term: string;
}

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
		return [resolveModelSpec(cfg.tier, modelTiers)];
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		const candidateNodes = ctx.dependencyNodes[LEXICON_CANDIDATES_DEF.id] ?? [];

		// Collect this session's nominations. Terms already judged anywhere in the
		// corpus resolve to an existing input_key and the framework classifies them
		// `current` — no cross-session query is needed to get the cache.
		// Words and phrases are the same kind of subject — a corpus-wide string — so
		// they share one planning path and one cache. A phrase's id is simply its
		// words joined by a space.
		const terms = new Set<string>();
		for (const node of candidateNodes) {
			let props: LexiconCandidatesProperties;
			try {
				props = JSON.parse(node.content_json) as LexiconCandidatesProperties;
			} catch {
				continue;
			}
			for (const t of props.terms ?? []) terms.add(t.term);
			for (const p of props.phrases ?? []) terms.add(p.term);
		}

		// Sorted so the order of planned units is reproducible.
		return [...terms].sort().map((term): AnalysisUnit => {
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

		const response = await ctx.llm({
			model: resolveModelSpec(config.tier, ctx.modelTiers),
			system: ctx.prompts["classify_term"] ?? CLASSIFY_TERM_PROMPT,
			user: buildClassifyTermPrompt(term),
			temperature: config.temperature,
			maxTokens: 300,
			tool: CLASSIFY_TERM_TOOL,
		});

		const properties: FrustrationLexiconProperties = {
			...parseClassifyTermObject((response.structured as Record<string, unknown> | undefined) ?? {}),
			term,
		};

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
			durationMs: response.durationMs,
			edges: [
				{ toRefKind: REF_KINDS.SESSION, toRefId: unit.anchorRef, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
				{ toRefKind: REF_KINDS.PROMPT_VERSION, toRefId: CLASSIFY_TERM_PROMPT_HASH, edgeKind: EDGE_KINDS.USES_PROMPT, ordinal: 1 },
			],
		};
	},
};
