/**
 * The function-word stoplist: entries that can never be a frustration signal.
 *
 * The lexicon judges a term once for the whole corpus, with no surrounding turn
 * for context, so a cheap model sees `do` or `no` alone and answers
 * `frustration` / `negation`. The verdict is then cached corpus-wide and
 * permanently: on a real corpus the top-ranked "frustration" terms were `do`,
 * `no`, `do not`, `never`, `cannot` and `still` — ordinary instruction and
 * grammar words that appear in nearly every prompt. They dominated the ranking
 * and buried the real signal (profanity, "you keep stopping", elongation,
 * shouting).
 *
 * Prompt wording alone does not fix this. The prompt already said "ordinary
 * grammar is NEVER a signal", and the models still answered that way: the
 * instruction asks a model to reason about a *word*, and a bare `no` genuinely
 * reads as a negation marker in isolation. A **deterministic guard** does fix
 * it — the verdict is corrected after parsing, so no model can put a function
 * word in the lexicon.
 *
 * The guard is deliberately narrow, because the lexicon is a *widening* of
 * detection and must never become a gate:
 *
 *   - It applies to **single tokens only**. A multi-word term is not covered:
 *     `do not` on its own is grammar, but `do not` inside a pointed phrase
 *     ("do not mock the database" is not a complaint, but "do not do that
 *     again" is) can carry frustration, and a phrase is judged as a unit.
 *   - It only forces the *verdict* of a term that is in the list. The model may
 *     still describe it; the polarity and category are corrected to neutral and
 *     none.
 *
 * The list is English, which the nomination stage deliberately is not: nomination
 * is language-blind by design so it does not privilege the languages we
 * happened to think of. This list is a *stoplist of a known failure mode*, not a
 * general stopword list, and it only removes entries that a human would agree
 * are not frustration in any corpus. Other languages keep their own ordinary
 * words; the ranking problem this fixes was measured on an English-dominant
 * corpus.
 */

/**
 * English function words, bare negations, and grammar markers that carry no
 * feeling on their own.
 *
 * "Cannot" and "never" are here because they were measured as top-ranked
 * frustration terms on a real corpus, where they appear in instructions like
 * "never push to main" — normal prompts, not complaints.
 */
export const FRUSTRATION_STOPLIST: ReadonlySet<string> = new Set([
	// Bare auxiliaries and modals.
	"do",
	"does",
	"did",
	"done",
	"be",
	"been",
	"being",
	"am",
	"are",
	"was",
	"were",
	"will",
	"would",
	"shall",
	"can",
	"could",
	"may",
	"might",
	"must",
	"have",
	"has",
	"had",
	// Bare negations and their contractions.
	"no",
	"not",
	"none",
	"never",
	"nor",
	"neither",
	"without",
	"cant",
	"cannot",
	"dont",
	"don't",
	"doesnt",
	"doesn't",
	"didnt",
	"didn't",
	"wont",
	"won't",
	"isnt",
	"isn't",
	"arent",
	"aren't",
	"wasnt",
	"wasn't",
	"werent",
	"weren't",
	"shouldnt",
	"shouldn't",
	"couldnt",
	"couldn't",
	"wouldnt",
	"wouldn't",
	// Conjunctions, connectives, and ordinary adverbial filler.
	"but",
	"and",
	"or",
	"if",
	"then",
	"else",
	"so",
	"because",
	"as",
	"at",
	"by",
	"for",
	"from",
	"in",
	"into",
	"of",
	"on",
	"onto",
	"to",
	"with",
	"within",
	"when",
	"while",
	"yet",
	"still",
	"just",
	"very",
	"too",
	"also",
	"only",
	"even",
	"already",
	"again",
	"once",
	"here",
	"there",
	// Pronouns and determiners.
	"this",
	"that",
	"these",
	"those",
	"it",
	"its",
	"them",
	"they",
	"we",
	"you",
	"i",
	"he",
	"she",
	"his",
	"her",
	"our",
	"your",
	"my",
	"me",
	"us",
]);

/**
 * Whether a term is covered by the stoplist guard.
 *
 * A term qualifies only when it is a **single token** — no whitespace — and its
 * lowercased, trimmed form is in the list. A multi-word term is never covered:
 * a phrase is judged as a unit and can be a pointed complaint even when every
 * one of its words is individually ordinary.
 */
export function isStoplistedTerm(term: string): boolean {
	const trimmed = (term ?? "").trim();
	if (trimmed.length === 0) return false;
	if (/\s/.test(trimmed)) return false;
	return FRUSTRATION_STOPLIST.has(trimmed.toLowerCase());
}
