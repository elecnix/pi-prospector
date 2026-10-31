/**
 * Unit tests for prompt-form. Pure functions, no database, no mocks:
 * hand-written synthetic text only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scanPromptForm, shapeOf } from "../../src/analyze/analyzers/prompt-form/detect.js";

const prompt = (text: string, correction = false) => ({ text, correction });

describe("shapeOf", () => {
	it("reads a question mark as a question and its absence as an instruction", () => {
		assert.equal(shapeOf(prompt("Why does the build fail?"))?.kind, "question");
		assert.equal(shapeOf(prompt("Fix the build."))?.kind, "instruction");
		assert.equal(shapeOf(prompt("ビルドはなぜ失敗するのですか？"))?.kind, "question");
	});

	it("keeps a correction a correction even when it asks", () => {
		assert.equal(shapeOf(prompt("No, I said use the other flag, why not?", true))?.kind, "correction");
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
	it("folds kinds, length, buckets and structure", () => {
		const scan = scanPromptForm(
			[prompt("Fix it."), prompt("Why?"), prompt("x".repeat(500)), prompt("Nope, wrong.", true), prompt("```\nonly\n```")],
			2,
		);
		assert.equal(scan.typed_message_count, 5);
		assert.equal(scan.no_own_words_count, 1);
		assert.equal(scan.undecided_message_count, 2);
		assert.deepEqual(scan.kinds, { question: 1, instruction: 2, correction: 1 });
		assert.equal(scan.max_chars, 500);
		assert.equal(scan.sum_chars, 7 + 4 + 500 + 12);
		// bounds 20, 80, 300, 1000 and overflow
		assert.deepEqual(scan.length_buckets.map((b) => b.count), [3, 0, 0, 1, 0]);
	});

	it("sorts the configured bounds before bucketing", () => {
		const scan = scanPromptForm([prompt("x".repeat(50))], 0, { lengthBoundsChars: [100, 10], listMinLines: 3 });
		assert.deepEqual(scan.length_buckets, [{ le_chars: 10, count: 0 }, { le_chars: 100, count: 1 }, { le_chars: null, count: 0 }]);
	});

	it("returns zero counts and null statistics for no prompts", () => {
		const scan = scanPromptForm([], 0);
		assert.equal(scan.typed_message_count, 0);
		assert.equal(scan.median_chars, null);
		assert.deepEqual(scan.kinds, { question: 0, instruction: 0, correction: 0 });
	});
});
