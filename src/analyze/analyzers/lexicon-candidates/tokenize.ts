/**
 * Language-neutral tokenisation for the learned frustration lexicon.
 *
 * Every function here is pure and deterministic: the same text always yields the
 * same tokens, on any machine. That matters because these tokens feed a node's
 * `source_set_hash` — a tokeniser that drifted would re-identify every lexicon
 * node in the graph.
 *
 * The design goal is *no language assumptions*. There is no stopword list and no
 * stemming, because either would silently privilege the languages we happened to
 * think of. What we do filter is **shape**: code, paths, URLs, and identifiers
 * are not vocabulary, and nominating them would spend model calls on noise.
 *
 * `detectParalinguistic` covers the complementary case: frustration expressed
 * with no word at all — shouting, punctuation storms, elongated vowels. Those
 * markers need neither a lexicon nor a language, so they stay available even for
 * a user whose vocabulary the lexicon has never seen.
 */

/** Shortest accepted word token. Single letters carry no lexical signal. */
const MIN_TERM_LENGTH = 2;

/** Longest accepted word token. Anything longer is a hash, a blob, or a typo. */
const MAX_TERM_LENGTH = 32;

/**
 * A word token: letters and marks, with internal apostrophes kept so elisions
 * and contractions survive as one unit (`don't`, `c'est`). Digits are matched
 * here only so the shape filter can reject the token wholesale — a token with a
 * digit in it is a version, an identifier, or a filename, never vocabulary.
 */
const WORD_RE = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}]+)*/gu;

/**
 * An emoji token: a pictographic base plus any variation selectors, skin-tone
 * modifiers, and ZWJ-joined continuations, so `👍🏻` and `👨‍👩‍👧` each stay a
 * single token rather than fragmenting into their code points.
 */
const EMOJI_RE = /\p{Extended_Pictographic}(?:[\uFE0F\u{1F3FB}-\u{1F3FF}]|\u200D\p{Extended_Pictographic})*/gu;

/** Fenced code blocks — content, not conversation. */
const FENCED_CODE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;

/** Inline code spans. */
const INLINE_CODE_RE = /`[^`\n]*`/g;

/** URLs, including bare `www.` forms. */
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;

/**
 * Path-like runs: any non-whitespace containing a slash or backslash. Catches
 * `src/analyze/index.ts` and `C:\tmp\x.txt` alike without needing to know what a
 * path looks like on the host platform.
 */
const PATH_RE = /\S*[/\\]\S*/g;

/**
 * Dotted identifiers and filenames (`index.ts`, `foo.bar.baz`). A trailing
 * sentence period is left alone: the dot must sit between two word characters.
 */
const DOTTED_RE = /[\p{L}\p{N}_]+(?:\.[\p{L}\p{N}_]+)+/gu;

/** Snake_case / @-handles — identifiers rather than words. */
const IDENTIFIER_RE = /[@\p{L}\p{N}]*[_@][\p{L}\p{N}_@]*/gu;

/**
 * Machine-generated envelopes that ride *inside* user-role messages: harness
 * task notifications, captured bash output, system reminders, slash-command
 * echoes. The transcript files them under `user` because that is where they were
 * injected, but they are not the user's words, and nominating vocabulary from
 * them permanently caches junk verdicts.
 *
 * Matched as balanced `<tag>…</tag>` pairs with lowercase-hyphen names, then any
 * leftover standalone tag. The name pattern is deliberately narrow so ordinary
 * prose comparisons (`if x < 3 and y > 4`) are untouched.
 */
const MACHINE_BLOCK_RE = /<([a-z][a-z0-9-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/g;
const STANDALONE_TAG_RE = /<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?\/?>/g;

/**
 * Strip everything that is code, reference, or machine output rather than the
 * user's own language, replacing it with a space so surrounding tokens stay
 * separated.
 */
export function stripNonProse(text: string): string {
	return text
		.replace(FENCED_CODE_RE, " ")
		.replace(INLINE_CODE_RE, " ")
		// Machine blocks first: their contents must not survive as prose. Repeated
		// until stable so nested envelopes collapse fully.
		.replace(MACHINE_BLOCK_RE, " ")
		.replace(MACHINE_BLOCK_RE, " ")
		.replace(STANDALONE_TAG_RE, " ")
		.replace(URL_RE, " ")
		.replace(PATH_RE, " ")
		.replace(DOTTED_RE, " ")
		.replace(IDENTIFIER_RE, " ");
}

/** A word token survives only if it is the right length and carries no digits. */
function isAcceptableWord(token: string): boolean {
	if (token.length < MIN_TERM_LENGTH || token.length > MAX_TERM_LENGTH) return false;
	return !/\p{N}/u.test(token);
}

/**
 * The ordered token stream for a piece of user text: normalised, lowercased
 * words plus emoji, in the order they appear. Emoji bypass the length filter —
 * a single 🤬 is a complete signal.
 */
export function tokenize(text: string): string[] {
	if (!text) return [];
	const normalised = stripNonProse(text.normalize("NFKC"));

	// Collect words and emoji with their offsets, then merge by position so the
	// output preserves the order they appeared in rather than grouping by kind.
	const found: Array<{ index: number; token: string }> = [];

	for (const m of normalised.matchAll(WORD_RE)) {
		const token = m[0].toLowerCase();
		if (isAcceptableWord(token)) found.push({ index: m.index, token });
	}
	for (const m of normalised.matchAll(EMOJI_RE)) {
		found.push({ index: m.index, token: m[0] });
	}

	found.sort((a, b) => a.index - b.index);
	return found.map((f) => f.token);
}

/** The distinct tokens of a text. Matching against this set is substring-proof. */
export function tokenSet(text: string): Set<string> {
	return new Set(tokenize(text));
}

export interface TermCount {
	term: string;
	count: number;
}

/**
 * Distinct terms across several texts, ranked by frequency then alphabetically,
 * capped at `limit`.
 *
 * Frequency-first is deliberate: the commonest words get classified — and cached
 * — first, so within a handful of sessions the cap stops being spent on `the`
 * and starts reaching the rare, interesting vocabulary. The alphabetical
 * tie-break makes the selection reproducible regardless of message order.
 */
export function rankTerms(texts: readonly string[], limit: number): TermCount[] {
	const counts = new Map<string, number>();
	for (const text of texts) {
		for (const token of tokenize(text)) {
			counts.set(token, (counts.get(token) ?? 0) + 1);
		}
	}
	return [...counts.entries()]
		.map(([term, count]) => ({ term, count }))
		// Code-unit order, deliberately *not* `localeCompare`: collation depends on
		// the host's locale and ICU version, and this ordering decides which terms
		// survive the cap — and therefore what lands in a content-addressed node.
		// It has to be identical on every machine, not merely sensible on this one.
		.sort((a, b) => b.count - a.count || compareCodeUnits(a.term, b.term))
		.slice(0, Math.max(0, limit));
}

/** Locale-independent string ordering, for reproducible node identities. */
export function compareCodeUnits(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

// ───────────────────────── paralinguistic markers ─────────────────────────

/**
 * Frustration carried by *form* rather than vocabulary. These need no lexicon
 * and no language, so they keep working for a user whose words the lexicon has
 * never seen — the lexicon widens recall, it must never become the only path to it.
 */
export const PARALINGUISTIC_MARKERS = {
	/** Sustained capitals used for emphasis. */
	SHOUTING: "shouting",
	/** `???`, `!!`, `?!` — punctuation used to press. */
	REPEATED_PUNCTUATION: "repeated_punctuation",
	/** `nooooo`, `arrrgh` — a character held down. */
	ELONGATION: "elongation",
} as const;

export type ParalinguisticMarker = (typeof PARALINGUISTIC_MARKERS)[keyof typeof PARALINGUISTIC_MARKERS];

/** Two or more `?`/`!` in a row, in any mix. */
const REPEATED_PUNCT_RE = /[?!]{2,}/;

/** The same letter three or more times in a row, in any script. */
const ELONGATION_RE = /(\p{L})\1{2,}/u;

/** Word-ish runs, case preserved, for reading emphasis off the raw text. */
const CASED_WORD_RE = /[\p{L}\p{M}']+/gu;

/** A capitalised word pressed directly with `?` or `!` — `WHY?`, `WTF!!`. */
const PRESSED_CAPS_RE = /\p{Lu}{3,}[^\p{L}]*[?!]/u;

/** Shortest capitalised run that reads as a shouted *word* rather than an abbreviation. */
const SHOUTED_WORD_MIN_LENGTH = 5;

/**
 * Shouting, distinguished from an ordinary acronym.
 *
 * This is harder than it looks in a technical corpus, which is dense with
 * capitals that carry no affect at all: `CLI`, `AI`, `MCP SSE`, `HTTP GET`, `JSON
 * API`. Counting capitalised words — even requiring two of them — labels most of
 * a developer's ordinary prose as shouting; measured against a real corpus that
 * heuristic was wrong far more often than it was right.
 *
 * Two things separate emphasis from abbreviation. Shouting is **sustained**:
 * the capitals run across *adjacent* words, where scattered acronyms do not. And
 * it contains a **word**: acronyms are short and stay short, while a shouted word
 * is long enough to be one. So we require adjacent capitalised words with at
 * least one of real word length — or, for the short-and-angry case, a single
 * capitalised word pressed directly against `?`/`!` (`WHY?`, `WTF!`).
 */
function isShouting(text: string): boolean {
	let runLength = 0;
	let runLongestWord = 0;

	for (const match of text.matchAll(CASED_WORD_RE)) {
		const word = match[0];
		const isCaps = word.length >= 2 && /\p{Lu}/u.test(word) && !/\p{Ll}/u.test(word);
		if (!isCaps) {
			runLength = 0;
			runLongestWord = 0;
			continue;
		}
		runLength++;
		runLongestWord = Math.max(runLongestWord, word.length);
		if (runLength >= 2 && runLongestWord >= SHOUTED_WORD_MIN_LENGTH) return true;
	}

	return PRESSED_CAPS_RE.test(text);
}

/**
 * Lexicon-free frustration markers present in a piece of user text, in a stable
 * order so the resulting node identities are reproducible.
 */
export function detectParalinguistic(text: string): ParalinguisticMarker[] {
	if (!text) return [];
	// Read affect off the user's own prose only. Captured bash output and harness
	// notifications are full of capitals and punctuation that mean nothing about
	// how the person feels.
	const prose = stripNonProse(text.normalize("NFKC"));
	if (!prose.trim()) return [];

	const out: ParalinguisticMarker[] = [];
	if (isShouting(prose)) out.push(PARALINGUISTIC_MARKERS.SHOUTING);
	if (REPEATED_PUNCT_RE.test(prose)) out.push(PARALINGUISTIC_MARKERS.REPEATED_PUNCTUATION);
	if (ELONGATION_RE.test(prose)) out.push(PARALINGUISTIC_MARKERS.ELONGATION);
	return out;
}
