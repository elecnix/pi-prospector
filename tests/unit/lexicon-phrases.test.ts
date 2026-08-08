/**
 * Multi-word phrases in the learned lexicon.
 *
 * Single-token judgement structurally cannot see frustration that lives in a
 * bigram: `laisse tomber`, `trop lent`, `never mind`, `what the hell`. Every
 * component word is neutral on its own, and judging them individually is
 * *correct* — the signal simply is not in any one of them.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	tokenizeSegments,
	rankPhrases,
	matchPhrases,
} from "../../src/analyze/analyzers/lexicon-candidates/tokenize.js";

describe("tokenizeSegments", () => {
	it("splits on sentence boundaries so phrases cannot span them", () => {
		assert.deepEqual(tokenizeSegments("fix it. laisse tomber"), [
			["fix", "it"],
			["laisse", "tomber"],
		]);
		assert.deepEqual(tokenizeSegments("no! never mind"), [["no"], ["never", "mind"]]);
		assert.deepEqual(tokenizeSegments("why?\nforget it"), [["why"], ["forget", "it"]]);
	});

	it("keeps commas inside a segment — a phrase may span one", () => {
		assert.deepEqual(tokenizeSegments("putain, c'est faux"), [["putain", "c'est", "faux"]]);
	});

	it("drops empty segments", () => {
		assert.deepEqual(tokenizeSegments("... ok ..."), [["ok"]]);
	});
});

describe("rankPhrases", () => {
	it("builds adjacent bigrams within a segment only", () => {
		assert.deepEqual(
			rankPhrases(["laisse tomber"], 10).map((p) => p.term),
			["laisse tomber"],
		);
		// `it laisse` would be a bigram spanning a sentence boundary — never emitted.
		const across = rankPhrases(["fix it. laisse tomber"], 10).map((p) => p.term);
		assert.equal(across.includes("it laisse"), false);
		assert.equal(across.includes("laisse tomber"), true);
	});

	it("ranks by frequency then code-unit order, and caps", () => {
		const ranked = rankPhrases(["trop lent", "trop lent", "zzz aaa"], 1);
		assert.deepEqual(ranked, [{ term: "trop lent", count: 2 }]);
	});

	it("is locale-independent and reproducible", () => {
		const a = rankPhrases(["pénible vraiment", "beta alpha"], 10);
		const b = rankPhrases(["beta alpha", "pénible vraiment"], 10);
		assert.deepEqual(a, b);
	});
});

describe("matchPhrases", () => {
	it("finds a known phrase in a turn, counting occurrences", () => {
		const known = new Set(["laisse tomber", "trop lent"]);
		assert.deepEqual(matchPhrases("bon, laisse tomber. c'est trop lent", known), [
			{ phrase: "laisse tomber", count: 1 },
			{ phrase: "trop lent", count: 1 },
		]);
	});

	it("does not match across a sentence boundary", () => {
		assert.deepEqual(matchPhrases("fix it. laisse tomber", new Set(["it laisse"])), []);
	});

	it("returns phrases in a stable order regardless of where they appear", () => {
		const known = new Set(["trop lent", "laisse tomber"]);
		const a = matchPhrases("laisse tomber, trop lent", known).map((m) => m.phrase);
		const b = matchPhrases("trop lent, laisse tomber", known).map((m) => m.phrase);
		assert.deepEqual(a, b);
	});

	it("finds nothing when the lexicon knows no phrases", () => {
		assert.deepEqual(matchPhrases("laisse tomber", new Set()), []);
	});
});
