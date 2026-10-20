/**
 * The function-word guard on the frustration lexicon (issue #321).
 *
 * The lexicon judges a term once for the whole corpus, with no surrounding turn
 * for context, so a cheap model sees `do` or `no` alone and answers
 * "frustration" / "negation". Because a verdict is cached corpus-wide and
 * permanently, the top-ranked frustration terms on a real corpus became `do`
 * (254 hits), `no` (191), `do not` (172), `never` (152), `cannot` (129) and
 * `still` (90) — ordinary instruction and grammar words that appear in nearly
 * every prompt, dominating the ranking and burying the real signal.
 *
 * The fix is a **deterministic guard**, not prompt wording: the prompt already
 * said "ordinary grammar is NEVER a signal", and the models answered that way
 * anyway, because asked about a bare `no` a model does see a negation marker.
 * These tests pin the guard, and pin the boundary that keeps it from becoming a
 * gate: a multi-word term is not covered, because a phrase is judged as a unit
 * and can be a pointed complaint even when each of its words is ordinary.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FRUSTRATION_STOPLIST, isStoplistedTerm } from "../../src/analyze/analyzers/frustration-lexicon/stoplist.js";
import { parseClassifyTermObject, parseClassifyTermVerdict } from "../../src/analyze/analyzers/frustration-lexicon/prompt.js";

/** A verdict of the shape a cheap model returns for a bare negator. */
const FRUSTRATION_VERDICT = {
	polarity: "frustration",
	category: "negation",
	language: "en",
	confidence: 0.9,
	rationale: "a negation marker",
};

describe("the frustration-lexicon function-word stoplist", () => {
	it("covers the terms that dominated the ranking on a real corpus", () => {
		for (const term of ["do", "no", "never", "cannot", "still", "not", "none", "but", "and"]) {
			assert.equal(isStoplistedTerm(term), true, `'${term}' must never be a frustration signal`);
		}
	});

	it("covers the contractions of the bare negators", () => {
		for (const term of ["dont", "doesnt", "didnt", "wont", "isnt", "arent", "wasnt", "werent", "cant"]) {
			assert.equal(isStoplistedTerm(term), true, `'${term}' must never be a frustration signal`);
		}
	});

	it("ignores case and surrounding whitespace", () => {
		assert.equal(isStoplistedTerm("DO"), true);
		assert.equal(isStoplistedTerm("  Never  "), true);
	});

	it("does not cover a term that carries feeling on its own", () => {
		for (const term of ["putain", "faux", "wrong", "nope", "🤬", "merci", "brouette", "seriously"]) {
			assert.equal(isStoplistedTerm(term), false, `'${term}' is vocabulary, not a function word`);
		}
	});

	it("does not cover a multi-word term", () => {
		// A phrase is judged as a unit: "do not" on its own is grammar, but a phrase
		// can be a pointed complaint even when each of its words is ordinary.
		for (const term of ["do not", "never again", "not working"]) {
			assert.equal(isStoplistedTerm(term), false, `'${term}' is a phrase, not a bare function word`);
		}
	});

	it("covers only single tokens", () => {
		assert.equal(isStoplistedTerm(""), false);
		assert.equal(isStoplistedTerm("   "), false);
		assert.equal(FRUSTRATION_STOPLIST.has(""), false);
	});
});

describe("the guard on a parsed verdict", () => {
	it("forces a stoplisted term to neutral/none, whatever the model returned", () => {
		const verdict = parseClassifyTermVerdict("do", FRUSTRATION_VERDICT);
		assert.equal(verdict.polarity, "neutral");
		assert.equal(verdict.category, "none");
	});

	it("forces a stoplisted term the model was confident about", () => {
		const verdict = parseClassifyTermVerdict("never", { ...FRUSTRATION_VERDICT, confidence: 1 });
		assert.equal(verdict.polarity, "neutral");
		assert.equal(verdict.category, "none");
	});

	it("leaves a term the model judged as frustration alone", () => {
		const verdict = parseClassifyTermVerdict("putain", FRUSTRATION_VERDICT);
		assert.equal(verdict.polarity, "frustration");
		assert.equal(verdict.category, "negation");
	});

	it("leaves a multi-word term whose words are individually stoplisted alone", () => {
		const verdict = parseClassifyTermVerdict("do not", FRUSTRATION_VERDICT);
		assert.equal(verdict.polarity, "frustration");
		assert.equal(verdict.category, "negation");
	});

	it("does not change the raw parse", () => {
		// The unguarded parse is still available for callers that need the model's
		// own answer; the guard is a separate, explicit step.
		const raw = parseClassifyTermObject(FRUSTRATION_VERDICT);
		assert.equal(raw.polarity, "frustration");
		assert.equal(raw.category, "negation");
	});
});
