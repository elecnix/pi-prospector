/**
 * turn-frustration — where a session's turns meet the learned lexicon.
 *
 * Emits one `metric` node per *hit*: a (turn, signal) pair. Two kinds of signal
 * reach a turn here.
 *
 *   - **lexicon** — the turn's user text contains a term the corpus has judged
 *     to carry frustration (or praise), in any language.
 *   - **paralinguistic** — the turn shouts, piles on punctuation, or holds a
 *     letter down. These need neither a lexicon nor a language.
 *
 * The second kind exists because *the lexicon must never become a gate*. A user
 * whose vocabulary we have never seen, writing in a script we have never
 * adjudicated, can still be visibly frustrated; and the deterministic layer
 * already catches the wordless cases that leave a trace in the transcript (tool
 * failures, re-asking, empty replies, wasted output). This analyzer widens
 * recall — it must never be the only path to it.
 *
 * Identity is one node per (turn, signal), which makes growth purely additive:
 * learning a new word adds nodes for the turns that contain it and leaves every
 * other node in the corpus exactly as it was. A node holding *all* of a turn's
 * matches would instead change its own source set each time a word was learned,
 * stranding the previous node as neither revised nor superseded.
 */

import type {
	Analyzer,
	AnalyzerDef,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	AnalysisNodeRow,
	AnalysisResult,
	AnalysisUnit,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeSourceSetHash, computeConfigHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { buildTurnPairs } from "../turn-pair-core/build.js";
import { TURN_PAIR_CORE_DEF } from "../turn-pair-core/index.js";
import { detectParalinguistic, matchPhrases, tokenize } from "../lexicon-candidates/tokenize.js";
import {
	FRUSTRATION_LEXICON_DEF,
	type FrustrationLexiconProperties,
} from "../frustration-lexicon/index.js";
import { DEFAULT_TURN_FRUSTRATION_CONFIG, type TurnFrustrationConfig } from "./config.js";

export const TURN_FRUSTRATION_DEF: AnalyzerDef = {
	id: "turn-frustration",
	label: "Per-Turn Frustration Signals (deterministic)",
	description:
		"Matches each turn's user text against the corpus-wide learned lexicon — single terms and two-word phrases — and against lexicon-free markers (shouting, repeated punctuation, elongation), emitting one node per (turn, signal). No LLM. Detects verbal frustration in any language, including from users whose vocabulary the lexicon has never seen.",
	anchorSpan: "pair",
	dependencies: [TURN_PAIR_CORE_DEF.id, FRUSTRATION_LEXICON_DEF.id],
};

export const TURN_FRUSTRATION_VERSION: AnalyzerVersion = {
	analyzerId: TURN_FRUSTRATION_DEF.id,
	major: 1,
	// 1.1: also match learned two-word phrases (issue #40).
	// 1.2: a phrase hit is suppressed when one of its component words already fired
	// on the same turn. Measured over a real corpus, phrases produced 28,179 hits
	// against the word lexicon's 9,350, nearly all of them restating a word that had
	// already signalled. Fewer hits by design.
	minor: 2,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/turn-frustration/index.ts",
};

/** Where a hit came from. */
export type SignalSource = "lexicon" | "lexicon_phrase" | "paralinguistic";

export interface TurnFrustrationProperties {
	user_message_id: string;
	pair_index: number;
	signal_source: SignalSource;
	/** The matched term or phrase, or the marker name for a paralinguistic hit. */
	signal: string;
	polarity: string;
	category: string;
	language: string;
	/** Occurrences within the turn (always 1 for a paralinguistic marker). */
	count: number;
	/** Friction weight this hit contributes. */
	weight: number;
}

/**
 * The `term`-kind source id for a lexicon-free marker. Marker hits are keyed the
 * same way lexicon hits are, so a marker's identity is stable corpus-wide even
 * though no model ever judged it.
 */
export function paralinguisticSourceId(marker: string): string {
	return `paralinguistic:${marker}`;
}

interface HitMeta extends TurnFrustrationProperties {
	/** Output key of the lexicon node that justified a lexicon hit. */
	termOutputKey: string | null;
}

/** The usable lexicon: confident, non-neutral verdicts, newest per term. */
function usableLexicon(
	nodes: readonly AnalysisNodeRow[],
	config: TurnFrustrationConfig,
): Map<string, { props: FrustrationLexiconProperties; outputKey: string }> {
	const out = new Map<string, { props: FrustrationLexiconProperties; outputKey: string }>();
	for (const node of nodes) {
		let props: FrustrationLexiconProperties;
		try {
			props = JSON.parse(node.content_json) as FrustrationLexiconProperties;
		} catch {
			continue;
		}
		if (!props.term) continue;
		if (props.polarity === "neutral") continue;
		if (props.polarity === "praise" && !config.includePraise) continue;
		if (props.confidence < config.minConfidence) continue;
		out.set(props.term, { props, outputKey: node.output_key });
	}
	return out;
}

export const turnFrustrationAnalyzer: Analyzer = {
	def: TURN_FRUSTRATION_DEF,
	version: TURN_FRUSTRATION_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: TURN_FRUSTRATION_DEF.id,
		configHash: computeConfigHash(DEFAULT_TURN_FRUSTRATION_CONFIG),
		configJson: DEFAULT_TURN_FRUSTRATION_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		const config = (ctx.config as unknown as TurnFrustrationConfig) ?? DEFAULT_TURN_FRUSTRATION_CONFIG;
		// The lexicon is corpus-wide: a term learned in any session applies here.
		const lexicon = usableLexicon(ctx.getGlobalDependencyNodes(FRUSTRATION_LEXICON_DEF.id), config);

		const units: AnalysisUnit[] = [];
		for (const pair of buildTurnPairs(ctx.messages)) {
			if (!pair.userText.trim()) continue;

			// Lexicon hits. Matching runs over the tokenised text rather than a regex,
			// so it is Unicode-correct and cannot match inside a longer word — `no`
			// never fires on `north`.
			const counts = new Map<string, number>();
			for (const token of tokenize(pair.userText)) {
				// A phrase entry contains a space and can never equal a single token, but
				// checking keeps the two matching paths obviously disjoint.
				if (!token.includes(" ") && lexicon.has(token)) counts.set(token, (counts.get(token) ?? 0) + 1);
			}

			for (const term of [...counts.keys()].sort()) {
				const entry = lexicon.get(term)!;
				units.push(
					hitUnit(pair.index, pair.userMessageId, {
						user_message_id: pair.userMessageId,
						pair_index: pair.index,
						signal_source: "lexicon",
						signal: term,
						polarity: entry.props.polarity,
						category: entry.props.category,
						language: entry.props.language,
						count: counts.get(term) ?? 1,
						weight: config.lexiconHitWeight,
						termOutputKey: entry.outputKey,
					}),
				);
			}

			// Phrase hits, but only where the phrase contributes something its component
			// words do not already contribute by themselves.
			//
			// Without this rule the feature drowns in redundancy. Over a real corpus it
			// produced 28,179 phrase hits against the word lexicon's 9,350, and the top
			// entries were all restatements of a word that had already fired: `do not`
			// ×563, `is not` ×475, `with no` ×247 — and most plainly `👍 on` ×285 and
			// `with 👍` ×285, which are a praise emoji plus whichever word happened to
			// sit beside it.
			//
			// The test is contribution, not novelty of spelling: if a component word is
			// itself a signal that fired on this same turn, the phrase says nothing new
			// and is dropped. That is exactly what preserves `laisse tomber` — both
			// parts neutral, the meaning living only in the pair — while discarding
			// `do not`. Deterministic, so it holds whichever model judged the phrase.
			const firedWords = new Set(counts.keys());
			const knownPhrases = new Set([...lexicon.keys()].filter((k) => k.includes(" ")));
			for (const { phrase, count } of matchPhrases(pair.userText, knownPhrases)) {
				if (phrase.split(" ").some((word) => firedWords.has(word))) continue;
				const entry = lexicon.get(phrase)!;
				units.push(
					hitUnit(pair.index, pair.userMessageId, {
						user_message_id: pair.userMessageId,
						pair_index: pair.index,
						signal_source: "lexicon_phrase",
						signal: phrase,
						polarity: entry.props.polarity,
						category: entry.props.category,
						language: entry.props.language,
						count,
						weight: config.phraseHitWeight,
						termOutputKey: entry.outputKey,
					}),
				);
			}

			// Lexicon-free markers: available even when the lexicon knows none of these words.
			for (const marker of detectParalinguistic(pair.userText)) {
				units.push(
					hitUnit(pair.index, pair.userMessageId, {
						user_message_id: pair.userMessageId,
						pair_index: pair.index,
						signal_source: "paralinguistic",
						signal: marker,
						polarity: "frustration",
						category: marker,
						language: "und",
						count: 1,
						weight: config.paralinguisticWeight,
						termOutputKey: null,
					}),
				);
			}
		}
		return units;
	},

	analyze(unit: AnalysisUnit, _ctx: AnalyzerRunContext): AnalysisResult {
		const meta = unit.meta as unknown as HitMeta;
		const { termOutputKey, ...properties } = meta;

		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.MESSAGE, toRefId: unit.anchorRef, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
		];
		if (termOutputKey) {
			edges.push({
				toRefKind: REF_KINDS.ANALYSIS_NODE,
				toRefId: termOutputKey,
				edgeKind: EDGE_KINDS.CONSUMES,
				ordinal: 1,
			});
		}

		return {
			nodeKind: "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "message",
			anchorRef: unit.anchorRef,
			edges,
		};
	},
};

/**
 * Build the unit for one hit. The source set is the turn's message plus the
 * signal itself — never the whole lexicon — which is what keeps a newly learned
 * word from disturbing any turn that does not contain it.
 */
function hitUnit(pairIndex: number, userMessageId: string, meta: HitMeta): AnalysisUnit {
	const sources: SourceRef[] = [
		{ kind: "message", id: userMessageId },
		{
			kind: "term",
			id: meta.signal_source === "lexicon" ? meta.signal : paralinguisticSourceId(meta.signal),
		},
	];
	return {
		sources,
		sourceSetHash: computeSourceSetHash(sources),
		anchorKind: "message",
		anchorRef: userMessageId,
		meta: { ...meta, pair_index: pairIndex } as unknown as Record<string, unknown>,
	};
}
