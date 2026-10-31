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
 *     The user's own dictionary (`lexicon.dictionary`) files entries the same
 *     way, beside or instead of the learned lexicon per `lexicon.mode`, and
 *     each lexicon hit records which source filed it in `lexicon_source`.
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
import { detectParalinguistic, tokenize } from "../lexicon-candidates/tokenize.js";
import { findPhraseHits, isPhrase } from "../lexicon-candidates/phrases.js";
import {
	FRUSTRATION_LEXICON_DEF,
	type FrustrationLexiconProperties,
} from "../frustration-lexicon/index.js";
import { hasLoneExclamation } from "../lexicon-candidates/tokenize.js";
import { DEFAULT_TURN_FRUSTRATION_CONFIG, type TurnFrustrationConfig } from "./config.js";
import { getMutedTerms } from "../../../db/assertions.js";
import { currentHits } from "../../../db/muted-terms.js";
import { LexiconSource } from "./dictionary.js";
import { getSessionLineage } from "../../../db/queries.js";
import { MESSAGE_ORIGIN_DEF, type MessageOriginProperties } from "../message-origin/index.js";
import { getSessionMessageRows } from "../../../db/analysis-queries.js";
import { TURN_START_ROLES } from "../turn-pair-core/build.js";
import {
	isForkCopy,
	labelUserText,
	TEXT_ORIGINS,
	TextOrigin,
	type OriginMessage,
	type TextSpan,
} from "../../text-origin.js";
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
	/**
	 * Which source filed the term, on a lexicon hit: `model` (a verdict of the
	 * learned lexicon) or `dictionary` (the user's own entry). Absent on a
	 * paralinguistic hit, and on lexicon hits drawn before turn-frustration 1.9,
	 * which all came from the model.
	 */
	lexicon_source: Type.Optional(LexiconSource),
	/** Occurrences within the turn (always 1 for a paralinguistic marker). */
	count: Type.Number(),
	/** Friction weight this hit contributes. */
	weight: Type.Number(),
	/**
	 * Where the matched words came from (see `text-origin.ts`): `typed` when any
	 * occurrence is in text the person typed, otherwise the label most
	 * occurrences carry.
	 */
	origin: TextOrigin,
	/** Occurrences per origin. The values add up to `count`. */
	origins: Type.Object({
		typed: Type.Optional(Type.Number()),
		pasted: Type.Optional(Type.Number()),
		quoted: Type.Optional(Type.Number()),
		agent: Type.Optional(Type.Number()),
		notification: Type.Optional(Type.Number()),
		"fork-copy": Type.Optional(Type.Number()),
	}),
	/** Occurrences in typed text: the count a report of the person's own words uses. */
	typed_count: Type.Number(),
});
export type TurnFrustrationProperties = Static<typeof TurnFrustrationProperties>;

export const TURN_FRUSTRATION_DEF: AnalyzerDef = {
	id: "turn-frustration",
	label: "Per-Turn Frustration Signals (deterministic)",
	description:
		"Matches each turn's user text against the corpus-wide learned lexicon — single terms and two-word phrases — and against lexicon-free markers (shouting, repeated punctuation, elongation), emitting one node per (turn, signal). A lone `!` acts as a weight modulator rather than a signal. Each hit records the origin of the text it matched (typed, pasted, quoted, agent, notification, fork-copy). No LLM. Detects verbal frustration in any language, including from users whose vocabulary the lexicon has never seen.",
	anchorSpan: "pair",
	dependencies: [TURN_PAIR_CORE_DEF.id, FRUSTRATION_LEXICON_DEF.id, MESSAGE_ORIGIN_DEF.id],
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
	// 1.6: the function-word guard applied to the lexicon as it is read, not only
	// as it was written (issue #321). Superseded by 1.7.
	// 1.7: the guard is gone. A hand-written list of English function words could
	// not reach any language but English and decided by spelling what the corpus
	// can measure. Whether a term is background is now priced by the share of
	// analysed turns that carry it, in the readers (see `term-specificity.ts`),
	// so this analyzer fires a hit for every learned term the turn contains —
	// `do` included — and the reading decides that it is worth nothing. No
	// verdict is discarded here any more, so nothing about a term's *meaning*
	// depends on this build.
	// 1.8: a hit copies its term's category when it is drawn, and frustration-lexicon
	// 1.7 split `insult` out of profanity. The hit's identity is the turn and the
	// term, not the verdict, so a re-judged term leaves its hits current under the
	// old category. The bump makes them stale, and `--revise minor --revise-where
	// category=profanity` redraws only the hits that copied profanity.
	// 1.9: a user dictionary (`lexicon.mode` and `lexicon.dictionary` in
	// prospector.json). Every lexicon hit now records `lexicon_source`, `model` or
	// `dictionary`, and in `both` mode the user's entry wins over the model's
	// verdict for the same term. The default mode draws the same hits as 1.8 plus
	// `lexicon_source: "model"`, so a hit drawn by 1.8 is stale only for that field.
	// 1.10: every hit records the origin of the text it matched (typed, pasted,
	// quoted, agent, notification, fork-copy) and its occurrences per origin. The
	// count and the weight are unchanged, and so is the hit's identity, so a
	// `--revise minor` run redraws each hit beside its predecessor with the label.
	// 1.11: a pasted block whose closing tag repeats its attributes
	// (`</pasted_content id="4a2f">`, how Claude Code writes every paste) is now
	// labelled `pasted`. Before, the labeller found no closing tag, so a hit inside
	// a real paste kept the label `typed`. Only the origin fields can move.
	// 1.12: a hit reads the message-origin node of its turn. A message that node
	// labels `agent`, `notification` or `pasted` (decided) gives every occurrence in
	// it that label, so a brief an orchestrator wrote or a short terminal capture no
	// longer counts as the person's words. A message labelled `typed`, or undecided,
	// keeps the span labels. The node is an input by a `consumes` edge and stays out
	// of the hit's source set, as the lexicon verdict does, so a hit keeps its
	// identity and `--revise minor` redraws it beside its predecessor. The
	// whole-message rules that text-origin.ts had (child agent, signature, pi entry,
	// compaction) moved to message-origin and are gone from the span labeller.
	minor: 12,
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
	/** Output key of the lexicon node that justified a lexicon hit; null for a dictionary entry or a marker. */
	termOutputKey: string | null;
	/** Output key of the message-origin node the labels came from; null when the turn has none. */
	originOutputKey: string | null;
}

/** One usable lexicon entry, from either source. */
interface LexiconEntry {
	polarity: string;
	category: string;
	language: string;
	source: LexiconSource;
	/** The verdict node behind a model entry; null for a dictionary entry. */
	outputKey: string | null;
}

/**
 * The lexicon this run matches, per `lexiconMode`. In `both` mode the user's
 * entry replaces the model's verdict for the same term: the user wrote it for
 * their own corpus, and a verdict is the model's guess about the word in general.
 */
function activeLexicon(
	verdicts: readonly AnalysisNodeRow[],
	config: TurnFrustrationConfig,
): Map<string, LexiconEntry> {
	const mode = config.lexiconMode ?? "model";
	const out = new Map<string, LexiconEntry>();
	if (mode !== "dictionary") {
		for (const [term, { props, outputKey }] of usableLexicon(verdicts, config)) {
			out.set(term, { polarity: props.polarity, category: props.category, language: props.language, source: "model", outputKey });
		}
	}
	if (mode !== "model") {
		for (const entry of config.dictionary ?? []) {
			if (entry.polarity === "praise" && !config.includePraise) {
				out.delete(entry.term);
				continue;
			}
			out.set(entry.term, { polarity: entry.polarity, category: entry.category, language: entry.language, source: "dictionary", outputKey: null });
		}
	}
	return out;
}
/**
 * The usable lexicon: confident, non-neutral verdicts, newest per term.
 *
 * A word being *background* is deliberately not decided here. Whether a term is
 * ordinary vocabulary is a function of the corpus — the share of turns that
 * carry it — and the corpus grows, so the answer changes after this analyzer has
 * run. Deciding it here would freeze it into the hit node. The readers price it
 * instead (`hit-reading.ts`), which is the only place the corpus is current.
 */
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
		// The learned lexicon is corpus-wide: a term learned in any session applies
		// here. The user's dictionary joins or replaces it, per `lexiconMode`.
		const lexicon = activeLexicon(
			config.lexiconMode === "dictionary" ? [] : await ctx.getGlobalDependencyNodes(FRUSTRATION_LEXICON_DEF.id),
			config,
		);
		// The operator-muted terms (config, not derived). A muted term stops matching
		// new turns; its existing hit nodes stay and become stale/config lineage.
		const muted = new Set(await getMutedTerms(ctx.db));

		const origins = await originContext(ctx);

		const units: AnalysisUnit[] = [];
		for (const pair of await ctx.getTurnPairs(ctx.sessionId)) {
			if (!pair.userText.trim()) continue;

			// The turn's text, split by where each part came from. Each hit below
			// counts its occurrences per span, so the label never changes the count.
			const spans = origins.spansOf(pair.userMessageId, pair.userText, pair.timestamp);
			const originOutputKey = origins.keyOf(pair.userMessageId);
			const spanTokens = spans.map((span) => tokenize(span.text));

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
						polarity: entry.polarity,
						category: entry.category,
						language: entry.language,
						lexicon_source: entry.source,
						count: occurrences.length,
						weight: subsumed ? 0 : config.lexiconHitWeight * exclamationMultiplier,
						...originFields(spans, spans.map((_, i) => spanTokens[i]!.filter((t) => t === term).length), occurrences.length),
						termOutputKey: entry.outputKey,
						originOutputKey,
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
						polarity: entry.polarity,
						category: entry.category,
						language: entry.language,
						lexicon_source: entry.source,
						count: phraseCounts.get(phrase) ?? 1,
						weight: config.lexiconHitWeight * exclamationMultiplier,
						...originFields(
							spans,
							spans.map((span) => findPhraseHits(span.text, knownPhrases).filter((h) => h.phrase === phrase).length),
							phraseCounts.get(phrase) ?? 1,
						),
						termOutputKey: entry.outputKey,
						originOutputKey,
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
						...markerOrigin(spans, marker),
						termOutputKey: null,
						originOutputKey,
					}),
				);
			}
		}
		return units;
	},

	analyze(unit: AnalysisUnit, _ctx: AnalyzerRunContext): AnalysisResult {
		const meta = unit.meta as unknown as HitMeta;
		const { termOutputKey, originOutputKey, ...properties } = meta;

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
		if (originOutputKey) {
			edges.push({
				toRefKind: REF_KINDS.ANALYSIS_NODE,
				toRefId: originOutputKey,
				edgeKind: EDGE_KINDS.CONSUMES,
				ordinal: 2,
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

/** The fields a hit adds to record where its words came from. */
type OriginFields = Pick<TurnFrustrationProperties, "origin" | "origins" | "typed_count">;

/**
 * The label that stands for a whole turn when no single occurrence can be
 * placed: the label of the longest span, ties broken in `TEXT_ORIGINS` order.
 */
function dominantOrigin(spans: readonly TextSpan[]): TextOrigin {
	const length = new Map<TextOrigin, number>();
	for (const span of spans) length.set(span.origin, (length.get(span.origin) ?? 0) + span.text.length);
	return pickOrigin(length) ?? "typed";
}

/** `typed` when it has any share, otherwise the label with the most, ties broken in `TEXT_ORIGINS` order. */
function pickOrigin(tally: ReadonlyMap<TextOrigin, number>): TextOrigin | null {
	if ((tally.get("typed") ?? 0) > 0) return "typed";
	let best: TextOrigin | null = null;
	for (const origin of TEXT_ORIGINS) {
		const n = tally.get(origin) ?? 0;
		if (n > 0 && (best === null || n > (tally.get(best) ?? 0))) best = origin;
	}
	return best;
}

/**
 * Origin fields from per-span occurrence counts.
 *
 * Counting a word in each span finds the same occurrences as counting it in
 * the whole turn, because spans break only at a block edge or a line end. If
 * the two ever disagree, every occurrence goes to the turn's dominant label,
 * so `origins` always adds up to `count`.
 */
function originFields(spans: readonly TextSpan[], perSpan: readonly number[], count: number): OriginFields {
	const tally = new Map<TextOrigin, number>();
	spans.forEach((span, i) => {
		const n = perSpan[i] ?? 0;
		if (n > 0) tally.set(span.origin, (tally.get(span.origin) ?? 0) + n);
	});
	const placed = [...tally.values()].reduce((a, b) => a + b, 0);
	if (placed !== count) {
		tally.clear();
		tally.set(dominantOrigin(spans), count);
	}
	const origins: OriginFields["origins"] = {};
	for (const origin of TEXT_ORIGINS) {
		const n = tally.get(origin);
		if (n) origins[origin] = n;
	}
	return { origin: pickOrigin(tally) ?? dominantOrigin(spans), origins, typed_count: tally.get("typed") ?? 0 };
}

/**
 * Origin fields for a paralinguistic marker. A marker fires once per turn, so it
 * takes the label of a span that fires it alone (typed first), or the turn's
 * dominant label when only the whole turn fires it.
 */
function markerOrigin(spans: readonly TextSpan[], marker: string): OriginFields {
	const firing = new Map<TextOrigin, number>();
	for (const span of spans) {
		if (detectParalinguistic(span.text).includes(marker as ReturnType<typeof detectParalinguistic>[number])) firing.set(span.origin, 1);
	}
	const origin = pickOrigin(firing) ?? dominantOrigin(spans);
	return { origin, origins: { [origin]: 1 }, typed_count: origin === "typed" ? 1 : 0 };
}

/** Labels a session's turns. Built once per plan. */
interface OriginLabeller {
	spansOf: (messageId: string, text: string, timestamp: string | null) => TextSpan[];
	/** Output key of the turn's message-origin node, or null when it has none. */
	keyOf: (messageId: string) => string | null;
}

/**
 * Read what labelling needs beyond each turn's text: the turn-starting roles,
 * whether the session is a child agent's, and the parent's turns a fork may
 * have copied.
 *
 * A pi session with a parent is a fork. Every other host records a parent link
 * only for a child agent (Claude Code, pi-subagents, Codex, OpenCode, Cline).
 *
 * The parent's turns are an input outside the hit's source set, as the lexicon
 * verdict a hit copies is. A fork analysed before its parent was indexed keeps
 * `typed` on the copied turn until a revise redraws it.
 */
async function originContext(ctx: AnalyzerPlanContext): Promise<OriginLabeller> {
	const lineage = await getSessionLineage(ctx.db, ctx.sessionId);
	const parent = lineage?.parent_session ?? null;
	const parentTurns: OriginMessage[] =
		parent === null
			? []
			: (await getSessionMessageRows(ctx.db, parent))
					.filter((m) => TURN_START_ROLES.has(m.role) && m.content_text)
					.map((m) => ({ text: m.content_text ?? "", timestamp: m.timestamp }));
	const startedAt = lineage?.started_at || null;

	// The message-origin node of each turn, newest per message. A message with no
	// node (the analyzer did not run on it) keeps the span labels.
	const nodes = new Map<string, { origin: MessageOriginProperties["origin"]; decided: boolean; outputKey: string }>();
	for (const node of currentHits(ctx.dependencyNodes[MESSAGE_ORIGIN_DEF.id] ?? [])) {
		try {
			const props = JSON.parse(node.content_json) as MessageOriginProperties;
			nodes.set(props.user_message_id, { origin: props.origin, decided: props.decided, outputKey: node.output_key });
		} catch {
			continue;
		}
	}
	return {
		keyOf: (messageId) => nodes.get(messageId)?.outputKey ?? null,
		spansOf: (messageId, text, timestamp) => {
			if (parentTurns.length > 0 && isForkCopy({ text, timestamp }, startedAt, parentTurns)) return labelUserText(text, { forkCopy: true });
			// A decided label for the whole message is final unless the person typed it.
			// `typed` and an undecided message keep the finer span labels.
			const node = nodes.get(messageId);
			if (node?.decided && node.origin !== "typed" && text.trim()) return [{ origin: node.origin, text }];
			return labelUserText(text, { forkCopy: false });
		},
	};
}
