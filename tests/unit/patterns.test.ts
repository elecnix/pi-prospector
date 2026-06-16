import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	classifyCorrection,
	detectRepetition,
	extractCorrectionText,
} from "../../src/analyze/analyzers/turn-pair-core/patterns.js";

describe("classifyCorrection", () => {
	it("detects strong explicit corrections", () => {
		const r = classifyCorrection("No, use pnpm instead of npm", false);
		assert.equal(r.detected, true);
		assert.equal(r.type, "explicit");
		assert.ok(r.patterns.length > 0);
	});

	it("detects 'I said' style corrections", () => {
		assert.equal(classifyCorrection("I said use the other function", false).type, "explicit");
	});

	it("detects weak/implicit corrections", () => {
		const r = classifyCorrection("could you try a different approach", false);
		assert.equal(r.detected, true);
		assert.equal(r.type, "implicit");
	});

	it("detects leading negation", () => {
		assert.equal(classifyCorrection("not what I wanted", false).type, "explicit");
	});

	it("returns none for neutral continuation", () => {
		const r = classifyCorrection("Thanks, now add a test for the parser", false);
		assert.equal(r.detected, false);
		assert.equal(r.type, null);
	});

	it("does not treat positive feedback as a correction", () => {
		assert.equal(classifyCorrection("looks good, thanks!", false).detected, false);
	});

	it("marks repetition when flagged", () => {
		const r = classifyCorrection("run the tests", true);
		assert.equal(r.type, "repetition");
		assert.equal(r.detected, true);
	});
});

describe("detectRepetition", () => {
	it("flags short re-asks sharing tokens", () => {
		assert.equal(detectRepetition("run the tests please", "how do I run the tests"), true);
	});

	it("ignores long messages", () => {
		const long = "x".repeat(120);
		assert.equal(detectRepetition(long, long), false);
	});

	it("ignores when no prior text", () => {
		assert.equal(detectRepetition("run tests", null), false);
	});

	it("ignores unrelated short messages", () => {
		assert.equal(detectRepetition("ok", "completely different subject matter"), false);
	});
});

describe("extractCorrectionText", () => {
	it("slices the remainder after the matched pattern", () => {
		const text = "actually use yarn";
		const result = extractCorrectionText(text, "\\bactually[,.\\s]");
		assert.ok(result.includes("use yarn"));
	});

	it("falls back to a prefix when pattern does not match", () => {
		const result = extractCorrectionText("some text", "\\bzzz\\b");
		assert.ok(result.length > 0);
	});
});
