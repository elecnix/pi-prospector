/**
 * The user's frustration dictionary: words and phrases the user files under a
 * category themselves, matched by turn-frustration beside (or instead of) the
 * learned lexicon.
 *
 * A dictionary is configuration, not derived analysis: the user wrote it, so it
 * reaches turn-frustration through its config and enters the hit's recipe there.
 * Entries are normalised here with the same tokeniser the turns go through, so
 * an entry matches exactly the text it would match if the model had learned it.
 */

import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { tokenize } from "../lexicon-candidates/tokenize.js";
import { PHRASE_JOINER, tokenizeSegments } from "../lexicon-candidates/phrases.js";

/**
 * Where lexicon hits come from: the learned lexicon (`model`, the default), the
 * user's dictionary alone (`dictionary`, no model calls), or both.
 */
export const LexiconMode = Type.Union([Type.Literal("model"), Type.Literal("dictionary"), Type.Literal("both")]);
export type LexiconMode = Static<typeof LexiconMode>;

/** Which source a lexicon hit came from. */
export const LexiconSource = Type.Union([Type.Literal("model"), Type.Literal("dictionary")]);
export type LexiconSource = Static<typeof LexiconSource>;

/** One entry as the user writes it in prospector.json or the dictionary file. */
export const DictionaryEntryInput = Type.Object({
	/** A word or a phrase of several words. */
	term: Type.String({ minLength: 1 }),
	/** The category a hit is filed under, e.g. `profanity`, `insult`, `correction`, `praise`. */
	category: Type.String({ minLength: 1 }),
	/** `praise` when the category is `praise`, else `frustration`. */
	polarity: Type.Optional(Type.Union([Type.Literal("frustration"), Type.Literal("praise")])),
	/** ISO 639-1 code; `und` when absent. */
	language: Type.Optional(Type.String({ minLength: 1 })),
});
export type DictionaryEntryInput = Static<typeof DictionaryEntryInput>;

/** One entry after normalisation, as it is stored in turn-frustration's config. */
export const DictionaryEntry = Type.Object({
	term: Type.String(),
	polarity: Type.Union([Type.Literal("frustration"), Type.Literal("praise")]),
	category: Type.String(),
	language: Type.String(),
});
export type DictionaryEntry = Static<typeof DictionaryEntry>;

/**
 * Validate and normalise a dictionary. Each term goes through the turn
 * tokeniser and is rejoined with single spaces, so `Laisse  tomber` becomes
 * `laisse tomber`. The result is sorted by term, so the config fingerprint does
 * not depend on the order the user wrote the entries in.
 *
 * Throws when an entry could never match as written: a word the tokeniser drops
 * (a single letter, a token with a digit) or a phrase across a sentence boundary
 * would otherwise sit in the config and silently do nothing.
 */
export function normalizeDictionary(entries: readonly unknown[]): DictionaryEntry[] {
	const byTerm = new Map<string, DictionaryEntry>();
	entries.forEach((raw, index) => {
		if (!Check(DictionaryEntryInput, raw)) {
			throw new Error(
				`lexicon.dictionary[${index}] must be an object with a non-empty "term" and "category", ` +
					`an optional "polarity" ("frustration" or "praise"), and an optional "language".`,
			);
		}
		const words = raw.term.trim().split(/\s+/u);
		const tokens = tokenize(raw.term);
		if (tokens.length === 0 || tokens.length !== words.length) {
			throw new Error(
				`lexicon.dictionary entry "${raw.term}" cannot match as written: the tokeniser keeps ` +
					`[${tokens.join(", ")}] of it. Every word needs two or more letters and no digits.`,
			);
		}
		if (tokenizeSegments(raw.term).length > 1) {
			throw new Error(
				`lexicon.dictionary entry "${raw.term}" spans a sentence boundary, and a phrase only matches within one sentence.`,
			);
		}
		const term = tokens.join(PHRASE_JOINER);
		if (byTerm.has(term)) {
			throw new Error(`lexicon.dictionary lists "${term}" twice. Keep one entry per term.`);
		}
		byTerm.set(term, {
			term,
			polarity: raw.polarity ?? (raw.category === "praise" ? "praise" : "frustration"),
			category: raw.category,
			language: raw.language ?? "und",
		});
	});
	return [...byTerm.values()].sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
}
