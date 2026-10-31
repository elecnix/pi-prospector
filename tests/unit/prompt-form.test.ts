/**
 * Unit tests for prompt-form. Pure functions, no database, no mocks:
 * hand-written synthetic text only. The kind of a prompt is a classifier answer
 * that the caller supplies, so these tests never look at punctuation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scanPromptForm, shapeOf, type TypedPrompt } from "../../src/analyze/analyzers/prompt-form/detect.js";

const prompt = (text: string, kind: TypedPrompt["kind"] = "instruction"): TypedPrompt => ({ text, kind });

describe("shapeOf", () => {
	it("takes the kind from the answer and never from a question mark", () => {
		assert.equal(shapeOf(prompt("Fix the build?", "instruction"))?.kind, "instruction");
		assert.equal(shapeOf(prompt("why does the build fail", "question"))?.kind, "question");
		assert.equal(shapeOf(prompt("ビルドはなぜ失敗するのですか", "question"))?.kind, "question");
	});

	it("measures only the person's own words", () => {
		const text = "Look at this log.\n\n```\nerror: a\nerror: b\n```";
		const shape = shapeOf(prompt(text));
		assert.equal(shape?.chars, "Look at this log.".length);
		assert.equal(shape?.has_code_block, true, "a fenced block still counts as form");
	});

	it("finds a list and a heading", () => {
		const text = "## Plan\n- add the field\n- migrate rows\n- drop the column";
		const shape = shapeOf(prompt(text));
		assert.equal(shape?.has_list, true);
		assert.equal(shape?.has_heading, true);
		assert.equal(shapeOf(prompt("- one\n- two"))?.has_list, false, "two lines are not a list");
	});

	it("returns null when none of the words are the person's own", () => {
		assert.equal(shapeOf(prompt("```\nonly a pasted block\n```")), null);
	});
});

describe("scanPromptForm", () => {
	it("folds kinds, length, buckets and structure, and keeps unknown apart from zero", () => {
		const scan = scanPromptForm(
			[
				prompt("Fix it."),
				prompt("Why", "question"),
				prompt("x".repeat(500), "unknown"),
				prompt("Nope, wrong.", "correction"),
				prompt("```\nonly\n```"),
				prompt("thanks", "other"),
			],
			2,
		);
		assert.equal(scan.typed_message_count, 6);
		assert.equal(scan.no_own_words_count, 1);
		assert.equal(scan.undecided_message_count, 2);
		assert.deepEqual(scan.kinds, { question: 1, instruction: 1, correction: 1, other: 1, unknown: 1 });
		assert.equal(scan.max_chars, 500);
		assert.equal(scan.sum_chars, 7 + 3 + 500 + 12 + 6);
		// bounds 20, 80, 300, 1000 and overflow
		assert.deepEqual(scan.length_buckets.map((b) => b.count), [4, 0, 0, 1, 0]);
	});

	it("sorts the configured bounds before bucketing", () => {
		const scan = scanPromptForm([prompt("x".repeat(50))], 0, { lengthBoundsChars: [100, 10], listMinLines: 3, minKindConfidence: 0.6 });
		assert.deepEqual(scan.length_buckets, [{ le_chars: 10, count: 0 }, { le_chars: 100, count: 1 }, { le_chars: null, count: 0 }]);
	});

	it("returns zero counts and null statistics for no prompts", () => {
		const scan = scanPromptForm([], 0);
		assert.equal(scan.typed_message_count, 0);
		assert.equal(scan.median_chars, null);
		assert.deepEqual(scan.kinds, { question: 0, instruction: 0, correction: 0, other: 0, unknown: 0 });
	});
});
