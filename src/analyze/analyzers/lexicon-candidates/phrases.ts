/**
 * Multi-word lexicon phrases (#40): segmentation, nomination, and matching.
 *
 * A phrase is just another corpus-keyed subject: nominated from adjacent tokens
 * within a sentence segment under its own tight cap, judged by exactly the same
 * pipeline as a word, and matched at turn level over the same token stream.
 *
 * Everything here builds on {@link tokenizeSegments}, which splits the token
 * stream at sentence boundaries so a phrase can never be nominated or matched
 * across a boundary it could not survive as a unit.
 */

import { compareCodeUnits, extractTokens, rankByFrequency, toProse } from "./tokenize.js";
import type { TermCount } from "./tokenize.js";

/** Strong sentence boundaries. Commas are deliberately *not* included: a phrase may legitimately span one (`putain, c'est faux`), whereas a phrase spanning a full stop is an artefact of two unrelated sentences sitting side by side. */
const SEGMENT_SPLIT_RE = /[.!?:;\n\r]+/;

/** Words per phrase. Bigrams only for now; trigrams multiply the noise. TODO(#40): consider trigrams only if bigram adjudications over a real corpus prove clean enough to widen the window. */
const PHRASE_LENGTH = 2;

/** The canonical joiner inside a phrase's term id (`laisse tomber`). */
export const PHRASE_JOINER = " ";

/** Whether a lexicon entry is a multi-word phrase rather than a single token. */
export function isPhrase(entry: string): boolean {
	return entry.includes(PHRASE_JOINER);
}

/**
 * The token stream split at sentence boundaries.
 *
 * Phrase extraction needs this. Without it `fix it. laisse tomber` yields the
 * bigram `it laisse`, which nobody said — it is the seam between two sentences.
 * Every phrase produced or matched here is built within a single segment, and
 * stripping runs on the whole text first so machine envelopes that contain
 * sentence punctuation cannot leak their contents as segments.
 */
export function tokenizeSegments(text: string): string[][] {
	return toProse(text)
		.split(SEGMENT_SPLIT_RE)
		.map((segment) => extractTokens(segment))
		.filter((tokens) => tokens.length > 0);
}

/** Every adjacent n-gram within each segment of each text, in order. */
function phrasesOf(texts: readonly string[]): string[] {
	const out: string[] = [];
	for (const text of texts) {
		for (const segment of tokenizeSegments(text)) {
			for (let i = 0; i + PHRASE_LENGTH <= segment.length; i++) {
				out.push(segment.slice(i, i + PHRASE_LENGTH).join(PHRASE_JOINER));
			}
		}
	}
	return out;
}

/**
 * Distinct phrases across several texts, ranked by frequency then alphabetically
 * and capped at `limit` — exactly like {@link rankTerms}, but under its own cap.
 *
 * Bigrams vastly outnumber unigrams and most are junk, so sharing the term cap
 * would let them crowd out vocabulary that is meaningful on its own; and because
 * a verdict is cached corpus-wide and permanently, every junk phrase judged once
 * is junk stored forever. The cap therefore stays deliberately tight: it bounds
 * how many unproven adjacent pairs any one session may put forward, spending the
 * permanent cache only on the most frequently repeated candidates.
 */
export function rankPhrases(texts: readonly string[], limit: number): TermCount[] {
	return rankByFrequency(phrasesOf(texts), limit);
}

/** One occurrence of a known phrase, as a span over the text's full token stream (end exclusive). */
export interface PhraseHit {
	phrase: string;
	start: number;
	end: number;
}

/**
 * Where the `known` phrases occur in a text, with token-index spans.
 *
 * A windowed n-gram compare over the same segmentation nomination used, so
 * matching inherits the Unicode-correct, substring-proof guarantees of the
 * tokeniser and can never bridge a sentence boundary. Output is sorted by span,
 * then phrase, so hit identity never depends on where in the message a phrase
 * fell or on lexicon insertion order.
 */
export function findPhraseHits(text: string, known: ReadonlySet<string>): PhraseHit[] {
	if (!text || known.size === 0) return [];
	// Only multi-token entries participate; single tokens are matched by the term path.
	const parts = [...known]
		.filter(isPhrase)
		.map((p) => p.split(PHRASE_JOINER));
	if (parts.length === 0) return [];

	const hits: PhraseHit[] = [];
	let offset = 0;
	for (const segment of tokenizeSegments(text)) {
		for (let i = 0; i < segment.length; i++) {
			for (const candidate of parts) {
				if (i + candidate.length > segment.length) continue;
				let ok = true;
				for (let j = 0; j < candidate.length; j++) {
					if (segment[i + j] !== candidate[j]) {
						ok = false;
						break;
					}
				}
				if (ok) hits.push({ phrase: candidate.join(PHRASE_JOINER), start: offset + i, end: offset + i + candidate.length });
			}
		}
		offset += segment.length;
	}
	return hits.sort((a, b) => a.start - b.start || a.end - b.end || compareCodeUnits(a.phrase, b.phrase));
}
