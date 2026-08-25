/**
 * turn-frustration — where a session's turns meet the learned lexicon.
 *
 * Emits one `metric` node per *hit*: a (turn, signal) pair. Two kinds of signal
 * reach a turn here.
 *
 *   - **lexicon** — the turn's user text contains an entry the corpus has judged
 *     to carry frustration (or praise), in any language. Entries are single
 *     words **or two-word phrases** (`laisse tomber`, `trop lent`, #40): a
 *     phrase is just a longer corpus-keyed subject, matched over the same
 *     token stream as a word by a windowed n-gram compare within sentence
 *     segments.
 *   - **paralinguistic** — the turn shouts, piles on punctuation, or holds a
 *     letter down. These need neither a lexicon nor a language.
 *
 * A third form feature is a **modulator**, not a signal: a lone exclamation
 * mark (`hi!`, `wait, no!`) fires no hit of its own — `great!` and `angry!`
 * are indistinguishable — but scales the weight of the signals the turn already
 * carries. A modulator with nothing to modulate produces nothing.
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
import { TURN_PAIR_CORE_DEF } from "../turn-pair-core/index.js";
import { detectParalinguistic, findPhraseHits, isPhrase, tokenize } from "../lexicon-candidates/tokenize.js";
import {
	FRUSTRATION_LEXICON_DEF,
	type FrustrationLexiconProperties,
} from "../frustration-lexicon/index.js";
import { hasLoneExclamation } from "../lexicon-candidates/tokenize.js";
import { DEFAULT_TURN_FRUSTRATION_CONFIG, type TurnFrustrationConfig } from "./config.js";
import { getMutedTerms } from "../../../db/assertions.js";
import { Type, type Static } from "typebox";

/** Where a hit came from. */
export const SignalSource = Type.Union([Type.Literal("lexicon"), Type.Literal("paralinguistic")]);
export type SignalSource = Static<typeof SignalSource>;

export const TurnFrustrationProperties = Type.Object({
	user_message_id: Type.String(),
	pair_index: Type.Number(),
	signal_source: SignalSource,
	/** The matched term, or the marker name for a paralinguistic hit. */
	signal: Type.String(),
	polarity: Type.String(),
	category: Type.String(),
	language: Type.String(),
	/** Occurrences within the turn (always 1 for a paralinguistic marker). */
	count: Type.Number(),
	/** Friction weight this hit contributes. */
	weight: Type.Number(),
});
export type TurnFrustrationProperties = Static<typeof TurnFrustrationProperties>;

export const TURN_FRUSTRATION_DEF: AnalyzerDef = {
	id: "turn-frustration",
	label: "Per-Turn Frustration Signals (deterministic)",
	description:
		"Matches each turn's user text against the corpus-wide learned lexicon — single terms and two-word phrases — and against lexicon-free markers (shouting, repeated punctuation, elongation), emitting one node per (turn, signal). A lone `!` acts as a weight modulator rather than a signal. No LLM. Detects verbal frustration in any language, including from users whose vocabulary the lexicon has never seen.",
	anchorSpan: "pair",
	dependencies: [TURN_PAIR_CORE_DEF.id, FRUSTRATION_LEXICON_DEF.id],
	outputSchema: TurnFrustrationProperties,
};

export const TURN_FRUSTRATION_VERSION: AnalyzerVersion = {
	analyzerId: TURN_FRUSTRATION_DEF.id,
	major: 1,
	// 1.1: also matched learned two-word phrases (issue #40).
	// 1.2: phrase matching removed — see #40. Word and paralinguistic signals stay.
	// 1.3: matching inherits the tokeniser's hyphen fix, so `re-check` no longer
	// yields a `re` token for a stale lexicon entry to match on.
	// 1.4: a lone `!` became a weight *modulator* rather than an undetected form
	// (issue #75): it still fires no hit, but multiplies each existing hit's weight.
	// 1.5: also matched learned two-word phrases (issue #40), windowed over the
	// same tokenisation nomination used. Purely additive — phrase hits are new
	// (turn, signal) subjects sharing the existing `lexicon` signal source, so
	// every existing hit node keeps its identity and nothing is recomputed. When
	// a term and an extending phrase both match the same turn, both hits are
	// emitted but the weight follows longest-match-preferred (see plan).
	minor: 5,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/turn-frustration/index.ts",
};

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

	// Term mutes are part of this analyzer's config: folding the active mute set
	// into the config fingerprint marks a muted term's existing hit nodes stale for
	// the `config` reason (the corpus no longer contradicts itself), while a plain
	// fill leaves them as preserved lineage. frustration-lexicon deliberately does
	// not set this — judging a word is unaffected by muting it.
	consultsAssertions: ["term"],

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		const config = (ctx.config as unknown as TurnFrustrationConfig) ?? DEFAULT_TURN_FRUSTRATION_CONFIG;
		// The lexicon is corpus-wide: a term learned in any session applies here.
		const lexicon = usableLexicon(await ctx.getGlobalDependencyNodes(FRUSTRATION_LEXICON_DEF.id), config);
		// The operator-muted terms (config, not derived). A muted term stops matching
		// new turns; its existing hit nodes stay and become stale/config lineage.
		const muted = new Set(await getMutedTerms(ctx.db));

		const units: AnalysisUnit[] = [];
		for (const pair of await ctx.getTurnPairs(ctx.sessionId)) {
			if (!pair.userText.trim()) continue;

			// The turn's modulator multiplier, computed once and applied to every hit
			// below. A lone `!` never creates a hit (it is polarity-agnostic), but it
			// scales the signals the turn already carries; runs like `!!` / `?!` are
			// already signals themselves and are deliberately not scaled by this.
			const exclamationMultiplier = hasLoneExclamation(pair.userText)
				? config.exclamationMultiplier
				: 1;

			// Lexicon hits. Matching runs over the tokenised text rather than a regex,
			// so it is Unicode-correct and cannot match inside a longer word — `no`
			// never fires on `north`. Single-term matches record their token positions,
			// which the overlap policy below needs alongside the counts.
			const positions = new Map<string, number[]>();
			for (const [index, token] of tokenize(pair.userText).entries()) {
				if (!isPhrase(token) && lexicon.has(token) && !muted.has(token)) {
					const at = positions.get(token) ?? [];
					at.push(index);
					positions.set(token, at);
				}
			}

			// Phrase matches: a windowed n-gram compare over the same segmentation
			// nomination used, so a phrase can never bridge a sentence boundary it was
			// not built across.
			const knownPhrases = new Set([...lexicon.keys()].filter((entry) => isPhrase(entry) && !muted.has(entry)));
			const phraseHits = findPhraseHits(pair.userText, knownPhrases);

			// Overlap policy (#40): existence stays additive — a term and an extending
			// phrase that both match this turn each get their own (turn, signal) hit
			// node — but the weight follows **longest-match-preferred**: when every
			// occurrence of a single-term hit lies inside some longer phrase hit's span,
			// that shorter hit carries weight 0 so the overlapping spans are not counted
			// twice toward ranking. The all-or-nothing rule keeps the calculation
			// deterministic and simple; a partially-covered term (some occurrences free)
			// still contributes full weight. Subsumed nodes stay recorded: they remain
			// evidence that the word fired, only priced at zero.
			const subsumedByPhrase = (tokenIndex: number): boolean =>
				phraseHits.some((h) => h.start <= tokenIndex && tokenIndex + 1 <= h.end);

			for (const term of [...positions.keys()].sort()) {
				const entry = lexicon.get(term)!;
				const occurrences = positions.get(term)!;
				const subsumed = occurrences.every(subsumedByPhrase);
				units.push(
					hitUnit(pair.index, pair.userMessageId, {
						user_message_id: pair.userMessageId,
						pair_index: pair.index,
						signal_source: "lexicon",
						signal: term,
						polarity: entry.props.polarity,
						category: entry.props.category,
						language: entry.props.language,
						count: occurrences.length,
						weight: subsumed ? 0 : config.lexiconHitWeight * exclamationMultiplier,
						termOutputKey: entry.outputKey,
					}),
				);
			}

			// Phrase hits share the `lexicon` signal source — a phrase IS a lexicon
			// entry — and carry full weight unless a future longer entry subsumes them;
			// today's bigrams can only be subsumed by nothing, since trigrams are not
			// yet nominated.
			const phraseCounts = new Map<string, number>();
			for (const hit of phraseHits) {
				phraseCounts.set(hit.phrase, (phraseCounts.get(hit.phrase) ?? 0) + 1);
			}
			for (const phrase of [...phraseCounts.keys()].sort()) {
				const entry = lexicon.get(phrase)!;
				units.push(
					hitUnit(pair.index, pair.userMessageId, {
						user_message_id: pair.userMessageId,
						pair_index: pair.index,
						signal_source: "lexicon",
						signal: phrase,
						polarity: entry.props.polarity,
						category: entry.props.category,
						language: entry.props.language,
						count: phraseCounts.get(phrase) ?? 1,
						weight: config.lexiconHitWeight * exclamationMultiplier,
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
						weight: config.paralinguisticWeight * exclamationMultiplier,
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
 * word (or phrase) from disturbing any turn that does not contain it. A phrase's
 * signal id is its space-joined normalised form, carried by the same `term`
 * source kind as any word.
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
