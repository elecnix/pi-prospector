import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	tokenize,
	tokenSet,
	rankTerms,
	detectParalinguistic,
	PARALINGUISTIC_MARKERS,
} from "../../src/analyze/analyzers/lexicon-candidates/tokenize.js";

describe("tokenize", () => {
	it("lowercases and splits on non-word characters", () => {
		assert.deepEqual(tokenize("That is Wrong, again!"), ["that", "is", "wrong", "again"]);
	});

	it("keeps non-Latin scripts intact", () => {
		assert.deepEqual(tokenize("не то опять"), ["не", "то", "опять"]);
		assert.deepEqual(tokenize("これは違う"), ["これは違う"]);
		assert.deepEqual(tokenize("c'est encore faux"), ["c'est", "encore", "faux"]);
	});

	it("emits emoji as their own tokens, including ZWJ and modifier sequences", () => {
		assert.deepEqual(tokenize("ugh 🤬"), ["ugh", "🤬"]);
		assert.deepEqual(tokenize("😤😤"), ["😤", "😤"]);
		assert.deepEqual(tokenize("👍🏻 ok"), ["👍🏻", "ok"]);
	});

	it("normalises compatibility forms and strips diacritic-preserving case", () => {
		// NFKC folds the fullwidth form onto ASCII.
		assert.deepEqual(tokenize("ＷＲＯＮＧ"), ["wrong"]);
		assert.deepEqual(tokenize("Pénible"), ["pénible"]);
	});

	it("drops fenced code blocks, inline code, URLs and path-like runs", () => {
		assert.deepEqual(tokenize("broken\n```\nconst wrong = 1\n```\nfix it"), ["broken", "fix", "it"]);
		assert.deepEqual(tokenize("see `formatArgsPreview` please"), ["see", "please"]);
		assert.deepEqual(tokenize("read https://example.com/wrong now"), ["read", "now"]);
		assert.deepEqual(tokenize("open src/analyze/index.ts again"), ["open", "again"]);
		assert.deepEqual(tokenize("open C:\\tmp\\x.txt again"), ["open", "again"]);
	});

	it("rejects tokens that are too short, too long, or carry digits", () => {
		// `node22` is dropped whole rather than salvaged as `node`: a token carrying a
		// digit is an identifier or a version, and half of one is not vocabulary.
		assert.deepEqual(tokenize("a no node22 12 " + "x".repeat(33)), ["no"]);
	});

	it("is idempotent and order-preserving", () => {
		const text = "No! that is STILL wrong 🤬";
		assert.deepEqual(tokenize(text), tokenize(text));
		assert.deepEqual(tokenize(text), ["no", "that", "is", "still", "wrong", "🤬"]);
	});
});

describe("tokenSet", () => {
	it("matches whole tokens only — never substrings", () => {
		// The classic `\b`-regex hazard: "no" must not match inside "north".
		const set = tokenSet("go north then nowhere");
		assert.equal(set.has("no"), false);
		assert.equal(set.has("north"), true);
	});

	it("is Unicode-correct for scripts JS word boundaries mishandle", () => {
		const set = tokenSet("совсем не то");
		assert.equal(set.has("не"), true);
		assert.equal(set.has("то"), true);
	});
});

describe("rankTerms", () => {
	it("ranks by count descending, then alphabetically, and caps", () => {
		const ranked = rankTerms(["wrong again wrong", "again wrong", "zzz bbb"], 3);
		assert.deepEqual(ranked, [
			{ term: "wrong", count: 3 },
			{ term: "again", count: 2 },
			{ term: "bbb", count: 1 },
		]);
	});

	it("returns a stable order for identical counts", () => {
		const a = rankTerms(["beta alpha gamma"], 10);
		const b = rankTerms(["gamma beta alpha"], 10);
		assert.deepEqual(a, b);
	});
});

describe("detectParalinguistic", () => {
	it("detects repeated punctuation", () => {
		assert.deepEqual(detectParalinguistic("why???"), [PARALINGUISTIC_MARKERS.REPEATED_PUNCTUATION]);
		assert.deepEqual(detectParalinguistic("stop!!"), [PARALINGUISTIC_MARKERS.REPEATED_PUNCTUATION]);
		assert.deepEqual(detectParalinguistic("really?!"), [PARALINGUISTIC_MARKERS.REPEATED_PUNCTUATION]);
	});

	it("detects character elongation in any script", () => {
		assert.deepEqual(detectParalinguistic("nooooo"), [PARALINGUISTIC_MARKERS.ELONGATION]);
		assert.deepEqual(detectParalinguistic("аaaaaa"), [PARALINGUISTIC_MARKERS.ELONGATION]);
	});

	it("detects shouting only when it is emphasis, not an acronym", () => {
		assert.deepEqual(detectParalinguistic("STOP DOING THAT"), [PARALINGUISTIC_MARKERS.SHOUTING]);
		assert.deepEqual(detectParalinguistic("WHY?").includes(PARALINGUISTIC_MARKERS.SHOUTING), true);
		// A lone acronym in ordinary prose is not shouting.
		assert.deepEqual(detectParalinguistic("please return JSON here"), []);
		assert.deepEqual(detectParalinguistic("open the PR now"), []);
	});

	it("returns markers in a stable, deduplicated order", () => {
		const markers = detectParalinguistic("WHY IS THIS STILL BROKEN???  nooooo");
		assert.deepEqual(markers, [
			PARALINGUISTIC_MARKERS.SHOUTING,
			PARALINGUISTIC_MARKERS.REPEATED_PUNCTUATION,
			PARALINGUISTIC_MARKERS.ELONGATION,
		]);
	});

	it("finds nothing in calm prose", () => {
		assert.deepEqual(detectParalinguistic("Could you update the README when you get a chance?"), []);
	});
});
