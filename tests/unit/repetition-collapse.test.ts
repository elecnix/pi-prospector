/**
 * Unit tests for the repetition-collapse analyzer's deterministic measures
 * (issue #278). Pure functions, no database, no mocks, no real session data —
 * hand-written synthetic strings only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_REPETITION_COLLAPSE_CONFIG,
	type RepetitionCollapseConfig,
} from "../../src/analyze/analyzers/repetition-collapse/config.js";
import {
	charRepetition,
	measureText,
	scanSteps,
	wordRepetition,
} from "../../src/analyze/analyzers/repetition-collapse/detect.js";
import type { TurnPair } from "../../src/analyze/analyzers/turn-pair-core/build.js";
import { makeMessageRow } from "./helpers.js";

const CONFIG: RepetitionCollapseConfig = { ...DEFAULT_REPETITION_COLLAPSE_CONFIG };

// An ordinary analysis: long, varied, never loops.
const PROSE = [
	"The build fails because the cache directory is created lazily by the first test that needs it.",
	"When the suite runs in parallel two workers race to create it and one of them sees a partial tree.",
	"A fix is to create the directory once in the global setup hook before any worker starts.",
	"Alternatively each worker could use its own subdirectory keyed by the worker index.",
	"The second option avoids shared state entirely, which also makes the failures easier to reproduce.",
	"I will check whether the runner exposes a worker index before choosing between them.",
].join(" ");

const SUBWORD_LOOP = "TestGet" + "Custom".repeat(400);
const PUNCT_LOOP = "backend_{" + "-_".repeat(600);
const SENTENCE_LOOP = "I realize I've been polling for a while. Let me just proceed with the next step. ".repeat(40);

describe("wordRepetition", () => {
	it("is near one for a sentence repeated many times", () => {
		assert.ok(wordRepetition(SENTENCE_LOOP, 4) > 0.95);
	});

	it("is zero for a sub-word loop, which is a single token", () => {
		assert.equal(wordRepetition(SUBWORD_LOOP, 4), 0);
		assert.equal(wordRepetition(PUNCT_LOOP, 4), 0);
	});

	it("is low for ordinary prose", () => {
		assert.ok(wordRepetition(PROSE, 4) < 0.1);
	});

	it("is zero for text shorter than one n-gram", () => {
		assert.equal(wordRepetition("one two three", 4), 0);
		assert.equal(wordRepetition("", 4), 0);
	});
});

describe("charRepetition", () => {
	it("is near one for a sub-word loop", () => {
		assert.ok(charRepetition(SUBWORD_LOOP, 16) > 0.98);
		assert.ok(charRepetition(PUNCT_LOOP, 16) > 0.98);
	});

	it("is zero for a loop whose motif is longer than the motif cap", () => {
		assert.ok(charRepetition(SENTENCE_LOOP, 16) < 0.01);
	});

	it("is low for ordinary prose", () => {
		assert.ok(charRepetition(PROSE, 16) < 0.05);
	});

	it("ignores whitespace-only motifs, so indentation is never a loop", () => {
		assert.equal(charRepetition(`x${" ".repeat(500)}y`, 16), 0);
	});

	it("is zero for the empty string", () => {
		assert.equal(charRepetition("", 16), 0);
	});
});

describe("measureText", () => {
	it("scores the stronger of the two measures", () => {
		const sub = measureText(SUBWORD_LOOP, CONFIG);
		assert.equal(sub.word, 0);
		assert.ok(sub.score > 0.98 && sub.score === sub.char);

		const sentence = measureText(SENTENCE_LOOP, CONFIG);
		assert.ok(sentence.char < 0.01);
		assert.ok(sentence.score > 0.95 && sentence.score === sentence.word);
	});

	it("carries the text length and the repeating motif, never the text itself", () => {
		const sub = measureText(SUBWORD_LOOP, CONFIG);
		assert.equal(sub.chars, SUBWORD_LOOP.length);
		assert.equal(sub.motif, "Custom");
		assert.equal(measureText(PUNCT_LOOP, CONFIG).motif, "-_");
		assert.equal(measureText(SENTENCE_LOOP, CONFIG).motif, "I realize I've been");
	});
});

// ─────────────────────────── scanSteps ───────────────────────────

function pairOf(index: number, ids: string[]): TurnPair {
	return {
		index,
		userMessageId: ids[0]!,
		messageIds: ids,
		userText: "",
		assistantText: "",
		thinkingText: "",
		toolCalls: [],
		toolResults: [],
		priorUserText: null,
		timestamp: null,
	};
}

describe("scanSteps", () => {
	it("judges every long-enough step and flags only the looping ones", () => {
		const messages = [
			makeMessageRow({ id: "u0", role: "user", content_text: "go" }),
			makeMessageRow({ id: "a0", role: "assistant", content_thinking: PROSE.repeat(1), content_text: "Done." }),
			makeMessageRow({ id: "u1", role: "user", content_text: "again" }),
			makeMessageRow({ id: "a1", role: "assistant", content_thinking: SUBWORD_LOOP, content_text: "", cost_usd: 0.42, stop_reason: "length" }),
		];
		const pairs = [pairOf(0, ["u0", "a0"]), pairOf(1, ["u1", "a1"])];
		const scan = scanSteps(pairs, messages, { ...CONFIG, minTextChars: 100 });

		assert.equal(scan.judged_step_count, 2);
		assert.equal(scan.collapsed.length, 1);
		const c = scan.collapsed[0]!;
		assert.equal(c.message_id, "a1");
		assert.equal(c.user_message_id, "u1");
		assert.equal(c.pair_index, 1);
		assert.equal(c.channel, "reasoning");
		assert.equal(c.delivered, false, "no answer text and no tool call");
		assert.equal(c.cost_usd, 0.42);
		assert.equal(c.stop_reason, "length");
	});

	it("a looping step that still emitted a tool call counts as delivered", () => {
		const messages = [
			makeMessageRow({ id: "u0", role: "user", content_text: "go" }),
			makeMessageRow({
				id: "a0",
				role: "assistant",
				content_thinking: SUBWORD_LOOP,
				tool_calls: JSON.stringify([{ name: "bash", arguments: { command: "ls" } }]),
			}),
		];
		const scan = scanSteps([pairOf(0, ["u0", "a0"])], messages, { ...CONFIG, minTextChars: 100 });
		assert.equal(scan.collapsed.length, 1);
		assert.equal(scan.collapsed[0]!.delivered, true);
	});

	it("measures the visible answer as well as the reasoning", () => {
		const messages = [
			makeMessageRow({ id: "u0", role: "user", content_text: "go" }),
			makeMessageRow({ id: "a0", role: "assistant", content_text: PUNCT_LOOP }),
		];
		const scan = scanSteps([pairOf(0, ["u0", "a0"])], messages, { ...CONFIG, minTextChars: 100 });
		assert.equal(scan.collapsed.length, 1);
		assert.equal(scan.collapsed[0]!.channel, "answer");
		assert.equal(scan.collapsed[0]!.delivered, false, "an answer that is itself the loop delivers nothing");
	});

	it("never judges text shorter than minTextChars: length is context, not a trigger", () => {
		const messages = [
			makeMessageRow({ id: "u0", role: "user", content_text: "go" }),
			makeMessageRow({ id: "a0", role: "assistant", content_thinking: "-_".repeat(40) }),
		];
		const scan = scanSteps([pairOf(0, ["u0", "a0"])], messages, CONFIG);
		assert.equal(scan.judged_step_count, 0);
		assert.equal(scan.collapsed.length, 0);
	});

	it("a long step that does not repeat is judged but never flagged", () => {
		const longProse = Array.from({ length: 60 }, (_, i) => `Line ${i} checks value ${i * i} against bound ${i * 3 + 1}.`).join(" ");
		const messages = [
			makeMessageRow({ id: "u0", role: "user", content_text: "go" }),
			makeMessageRow({ id: "a0", role: "assistant", content_thinking: longProse }),
		];
		const scan = scanSteps([pairOf(0, ["u0", "a0"])], messages, { ...CONFIG, minTextChars: 100 });
		assert.equal(scan.judged_step_count, 1);
		assert.equal(scan.collapsed.length, 0);
	});
});
