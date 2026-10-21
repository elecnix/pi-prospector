/**
 * Unit tests for the deterministic speech-act matchers (issue #318).
 *
 * Pure functions only — no database, no LLM, no mocks.
 *
 * The two matchers are *candidates*, never findings: the rebuttal matcher marks
 * a turn whose wording disputes a claim for the model layer to confirm, and
 * the apology matcher admits a turn to the analyzer that grades apologies.
 * What these tests pin down is therefore (a) which wordings match, (b) which
 * do not — above all the distinction the deterministic layer exists to keep:
 * an instruction is a correction, never a rebuttal — and (c) where a match is
 * skipped because it belongs to a code snippet, a quotation, or a condolence.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	matchApologyCandidates,
	matchRebuttalCandidates,
	isInCodeSpan,
	isInQuotedSpan,
} from "../../src/analyze/speech-acts.js";

/** The first matched text, or null when nothing matched. */
function firstMatch(text: string | null): string | null {
	return matchRebuttalCandidates(text)[0]?.text ?? null;
}

describe("matchRebuttalCandidates", () => {
	it("matches a dispute of a claim the assistant made", () => {
		assert.equal(firstMatch("that's wrong, use --repo"), "that's wrong");
		assert.equal(firstMatch("that is wrong"), "that is wrong");
		assert.equal(firstMatch("that's incorrect"), "that's incorrect");
		assert.equal(firstMatch("you're wrong about that"), "you're wrong");
		assert.equal(firstMatch("that flag doesn't exist"), "that flag doesn't exist");
		assert.equal(firstMatch("there's no such option"), "there's no such option");
		assert.equal(firstMatch("the test didn't pass, it failed"), "the test didn't pass");
		assert.equal(firstMatch("it didn't work"), "it didn't work");
		assert.equal(firstMatch("it's not true"), "it's not true");
		assert.equal(firstMatch("it failed"), "it failed");
	});

	it("matches a contractive negation as readily as the spelled-out one", () => {
		// The patterns name the contraction ("doesn't", "didn't") and the
		// spelled-out form ("does not", "did not") side by side, so both wordings
		// of the same dispute have to reach the matcher. A pattern that only
		// answered the spelled-out one would quietly miss half the disputes.
		assert.equal(firstMatch("that doesn't exist"), "that doesn't exist");
		assert.equal(firstMatch("that flag doesn't exist"), "that flag doesn't exist");
		assert.equal(firstMatch("it doesn't work"), "it doesn't work");
		assert.equal(firstMatch("the test doesn't pass"), "the test doesn't pass");
		assert.equal(firstMatch("the build doesn't compile"), "the build doesn't compile");
		assert.equal(firstMatch("that isn't true"), "that isn't true");
		assert.equal(firstMatch("it isn't true"), "it isn't true");
	});

	it("does not match an instruction — 'I told you to use X' stays a correction", () => {
		// The distinction the deterministic layer exists to keep: an instruction
		// asks for different behaviour and leaves the assistant's stated fact
		// unchallenged, so it is a correction and never a rebuttal.
		assert.equal(firstMatch("I told you to use X"), null);
		assert.equal(firstMatch("I told you to use pnpm, not npm"), null);
	});

	it("does not match other corrections and method disputes", () => {
		// Each of these is an instruction or a request for different behaviour,
		// not a dispute of something the assistant stated.
		const notDisputes = [
			"no, use yarn instead",
			"actually, I said use pnpm",
			"stop using npm",
			"instead of that, use the other branch",
			"please add a test for the parser",
		];
		for (const text of notDisputes) {
			assert.equal(firstMatch(text), null, `"${text}" is not a rebuttal`);
		}
	});

	it("does not match a claim about a thing rather than about what was said", () => {
		// "the wrong file" is a dispute of a choice, not of a stated fact.
		assert.equal(firstMatch("you edited the wrong file"), null);
	});

	it("returns nothing for an empty or absent message", () => {
		assert.deepEqual(matchRebuttalCandidates(null), []);
		assert.deepEqual(matchRebuttalCandidates(""), []);
	});

	it("skips a match inside a code span", () => {
		assert.equal(firstMatch("the error message was `that's wrong` in the log"), null);
		assert.equal(firstMatch("```\nthat's wrong\n```"), null);
	});

	it("reports one candidate per distinct span, in order", () => {
		const matches = matchRebuttalCandidates("that's wrong. also, it failed.");
		assert.deepEqual(matches.map((m) => m.text), ["that's wrong", "it failed"]);
		assert.ok(matches[1]!.index > matches[0]!.index, "candidates are ordered by position");
	});
});

describe("matchApologyCandidates", () => {
	it("matches the wordings the issue names", () => {
		assert.ok(matchApologyCandidates("Sorry, my mistake — the flag is --repo").length > 0);
		assert.ok(matchApologyCandidates("Apologies for the confusion").length > 0);
		assert.ok(matchApologyCandidates("I apologize for the wrong answer").length > 0);
		assert.ok(matchApologyCandidates("my mistake, I used the wrong flag").length > 0);
		assert.ok(matchApologyCandidates("I was wrong about the flag").length > 0);
	});

	it("matches the closings that concede without the word", () => {
		assert.ok(matchApologyCandidates("you're right, it should be --repo").length > 0);
		assert.ok(matchApologyCandidates("my error, sorry").length > 0);
	});

	it("matches a concession in either tense and either spelling", () => {
		// "I'm wrong" and "I was wrong" are the same concession, so a matcher
		// that answers only one of them answers half of them.
		for (const text of ["I was wrong", "I am wrong", "I'm wrong", "I was mistaken", "I'm mistaken"]) {
			assert.ok(matchApologyCandidates(text).length > 0, `"${text}" is a concession`);
		}
	});

	it("does not match ordinary prose", () => {
		assert.deepEqual(matchApologyCandidates("The build is green and the tests pass."), []);
		assert.deepEqual(matchApologyCandidates("Let me check the schema first."), []);
	});

	it("does not match a condolence — regret about the user's situation", () => {
		assert.deepEqual(matchApologyCandidates("Sorry to hear that."), []);
		assert.deepEqual(matchApologyCandidates("Sorry for your trouble."), []);
	});

	it("skips a match inside a code span", () => {
		assert.deepEqual(matchApologyCandidates("the command was `sorry --help`"), []);
		assert.deepEqual(matchApologyCandidates("```\nsorry about that\n```"), []);
	});

	it("skips a match inside a quoted span — the user quoting the assistant", () => {
		assert.deepEqual(matchApologyCandidates("You said 'sorry, use the other branch' earlier"), []);
		assert.deepEqual(matchApologyCandidates('You said "sorry, use the other branch" earlier'), []);
	});

	it("does not mistake a contraction's apostrophe for a quotation", () => {
		// "you're right" is a concession, and its apostrophe must not open a
		// quoted span that would swallow the match.
		assert.ok(matchApologyCandidates("you're right about that").length > 0);
		assert.ok(matchApologyCandidates("I'm sorry about that").length > 0);
	});

	it("returns nothing for an empty or absent response", () => {
		assert.deepEqual(matchApologyCandidates(null), []);
		assert.deepEqual(matchApologyCandidates(""), []);
	});
});

describe("isInCodeSpan", () => {
	it("detects an inline code span", () => {
		assert.equal(isInCodeSpan("run `npm test` now", 6), true);
		assert.equal(isInCodeSpan("run `npm test` now", 0), false);
	});

	it("detects a fenced block", () => {
		const text = "before\n```\nsorry\n```\nafter";
		assert.equal(isInCodeSpan(text, text.indexOf("sorry")), true);
		assert.equal(isInCodeSpan(text, 0), false);
	});

	it("treats a lone backtick in prose as no span", () => {
		assert.equal(isInCodeSpan("a ` b", 2), false);
	});
});

describe("isInQuotedSpan", () => {
	it("detects a double-quoted span", () => {
		assert.equal(isInQuotedSpan('he said "sorry" and left', 10), true);
		assert.equal(isInQuotedSpan('he said "sorry" and left', 0), false);
	});

	it("detects a blockquote line", () => {
		const text = "> the user wrote:\n> sorry";
		assert.equal(isInQuotedSpan(text, text.indexOf("sorry")), true);
	});

	it("does not treat a contraction as a quotation", () => {
		assert.equal(isInQuotedSpan("you're sorry", 3), false);
	});
});
