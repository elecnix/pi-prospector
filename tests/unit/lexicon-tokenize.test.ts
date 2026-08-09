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

	it("drops machine-generated envelopes that ride inside user messages", () => {
		// Harness output is stored under the `user` role but is not the user's words.
		// Nominating from it permanently caches junk verdicts, so it must never reach
		// the tokeniser.
		assert.deepEqual(
			tokenize("<task-notification><task-id>b84x</task-id></task-notification> fix it"),
			["fix", "it"],
		);
		assert.deepEqual(tokenize("<bash-stdout>Checking MCP server health</bash-stdout> broken"), ["broken"]);
		assert.deepEqual(tokenize("<system-reminder>Some NOTE here</system-reminder> ok"), ["ok"]);
		// Envelopes carry attributes too — these leaked in the first corpus run.
		assert.deepEqual(
			tokenize('<skill name="linear-ticket" location="/x/y">stop doing this</skill> hello'),
			["hello"],
		);
		// Ordinary prose containing comparisons is untouched.
		assert.deepEqual(tokenize("check if x < 3 and y > 4"), ["check", "if", "and"]);
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

	it("does not read a technical corpus's acronyms as shouting", () => {
		// Every one of these came from real corpus turns the first draft mislabelled.
		// Shouting is *sustained emphasis*: adjacent capitals, at least one of them a
		// word rather than an abbreviation. Acronyms are short and stay short.
		assert.deepEqual(detectParalinguistic("search the web for CLI tools that an AI agent can use"), []);
		assert.deepEqual(detectParalinguistic("add the MCP SSE server"), []);
		assert.deepEqual(detectParalinguistic("send an HTTP GET to the JSON API"), []);
		assert.deepEqual(detectParalinguistic("symlink .pi/agent/appendsystemprompt to my CLAUDE.md"), []);
		assert.deepEqual(detectParalinguistic("<bash-stdout>Checking MCP SERVER HEALTH</bash-stdout>"), []);
		// But genuine sustained emphasis still lands.
		assert.deepEqual(detectParalinguistic("THIS IS STILL BROKEN"), [PARALINGUISTIC_MARKERS.SHOUTING]);
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

describe("hyphenated compounds", () => {
	it("keeps an internal hyphen so prefixes are not judged as words", () => {
		// Splitting on the hyphen produced bare prefixes that the lexicon then judged
		// on their own: `re` fired 616 times and `non` 494 times over a real corpus,
		// both as "frustration", from `re-check` and `non-blocking`.
		assert.deepEqual(tokenize("re-check the non-blocking path"), ["re-check", "the", "non-blocking", "path"]);
		assert.deepEqual(tokenize("pre-existing well-known"), ["pre-existing", "well-known"]);
		assert.deepEqual(tokenize("e-mail"), ["e-mail"]);
	});

	it("does not treat a dash between words as part of a token", () => {
		// An em dash is punctuation, not a compound, and a trailing hyphen is a stray.
		assert.deepEqual(tokenize("this — that"), ["this", "that"]);
		assert.deepEqual(tokenize("wait - stop"), ["wait", "stop"]);
		assert.deepEqual(tokenize("trailing- word"), ["trailing", "word"]);
	});

	it("matches a hyphenated term as one unit", () => {
		const set = tokenSet("run the re-check now");
		assert.equal(set.has("re-check"), true);
		assert.equal(set.has("re"), false, "the bare prefix must not be matchable");
	});
});
