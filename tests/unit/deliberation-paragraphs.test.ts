/**
 * Unit tests for deliberation measurement (issue #104):
 *   - paragraph counting over reasoning text (pure function),
 *   - its emission from turn-pair-core scoring ("not recorded" → null),
 *   - its consumption as a routing-opportunity difficulty feature.
 * Hand-computed, no DB, no framework.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { countDeliberationParagraphs } from "../../src/analyze/analyzers/turn-pair-core/patterns.js";
import { scorePair } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { DEFAULT_TURN_PAIR_CORE_CONFIG } from "../../src/analyze/analyzers/turn-pair-core/config.js";
import { evaluateTurn } from "../../src/analyze/analyzers/routing-opportunity/index.js";
import { DEFAULT_ROUTING_CONFIG } from "../../src/analyze/analyzers/routing-opportunity/config.js";
import type { TurnPair } from "../../src/analyze/analyzers/turn-pair-core/build.js";

const coreCfg = { ...DEFAULT_TURN_PAIR_CORE_CONFIG };
const rcfg = { ...DEFAULT_ROUTING_CONFIG };

function pair(o: Partial<TurnPair>): TurnPair {
	return {
		index: 0,
		userMessageId: "u0",
		messageIds: ["u0", "a0"],
		userText: "do it",
		assistantText: "ok",
		thinkingText: "",
		toolCalls: [],
		toolResults: [],
		priorUserText: null,
		timestamp: null,
		...o,
	};
}

describe("countDeliberationParagraphs", () => {
	it("counts blocks separated by blank lines", () => {
		assert.equal(countDeliberationParagraphs("first point\nsecond line of same point\n\nsecond point"), 2);
		assert.equal(countDeliberationParagraphs("one\n\ntwo\n\nthree"), 3);
	});

	it("counts a single block as one paragraph", () => {
		assert.equal(countDeliberationParagraphs("just one consideration, wrapped\nover two lines"), 1);
	});

	it("ignores leading and trailing blank lines", () => {
		assert.equal(countDeliberationParagraphs("\n\nonly one\n\n"), 1);
	});

	it("handles CRLF line endings", () => {
		assert.equal(countDeliberationParagraphs("a\r\n\r\nb\r\n\r\nc"), 3);
	});

	it("treats whitespace-only lines as paragraph separators", () => {
		assert.equal(countDeliberationParagraphs("a\n   \n\t\nb"), 2);
	});

	it("returns 0 for empty and whitespace-only text", () => {
		assert.equal(countDeliberationParagraphs(""), 0);
		assert.equal(countDeliberationParagraphs("\n \n"), 0);
	});
});

describe("scorePair deliberation_paragraphs", () => {
	it("emits the paragraph count for a multi-paragraph turn", () => {
		const p = pair({ thinkingText: "consider A\n\nconsider B\n\nconsider C" });
		const r = scorePair(p, coreCfg);
		assert.equal(r.deliberation_paragraphs, 3);
	});

	it("emits 1 for a single block of reasoning", () => {
		const r = scorePair(pair({ thinkingText: "one block" }), coreCfg);
		assert.equal(r.deliberation_paragraphs, 1);
	});

	it("emits null — not 0 — when no reasoning was recorded", () => {
		const r = scorePair(pair({ thinkingText: "" }), coreCfg);
		assert.equal(r.deliberation_paragraphs, null);
	});

	it("emits null for whitespace-only reasoning", () => {
		const r = scorePair(pair({ thinkingText: "\n \n" }), coreCfg);
		assert.equal(r.deliberation_paragraphs, null);
	});
});

describe("routing-opportunity consumes deliberation_paragraphs", () => {
	function inputs(deliberation: number | null) {
		return {
			pair: pair({ toolCalls: [{ name: "edit", argumentsPreview: "" }] }),
			core: { correction_detected: false, tool_failure_count: 0, friction_score: 0, deliberation_paragraphs: deliberation },
			frustration: false,
			trajectorySignals: [],
			modelByMessageId: new Map([["u0", "claude-sonnet"], ["a0", "claude-sonnet"]]),
			costByMessageId: new Map<string, number>(),
			usageByMessageId: new Map([["u0", { input: 1000, cacheRead: 0 }], ["a0", { input: 1000, cacheRead: 0 }]]),
			cfg: rcfg,
		};
	}

	it("a heavy-deliberation, few-tool-call turn is not easy while an otherwise identical one is", () => {
		const heavy = evaluateTurn(inputs(5));
		assert.equal(heavy.features.tool_call_count, 1);
		assert.equal(heavy.easy, false);
		assert.equal(heavy.hard, false);
		assert.equal(heavy.verdict, "neutral");
		assert.equal(heavy.features.deliberation_paragraphs, 5);

		const light = evaluateTurn(inputs(null));
		assert.equal(light.easy, true);
		assert.equal(light.verdict, "downshift");

		const few = evaluateTurn(inputs(2));
		assert.equal(few.easy, true);
		assert.equal(few.verdict, "downshift");
	});

	it("null (not recorded) never blocks easiness on its own", () => {
		const r = evaluateTurn(inputs(null));
		assert.equal(r.features.deliberation_paragraphs, null);
		assert.equal(r.easy, true);
	});
});
