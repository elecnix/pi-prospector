/**
 * Unit tests for assistant-cognition prompt rendering and response parsing.
 *
 * Pure functions only — no database, no LLM, no mocks.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildCognitionPrompt,
	parseCognitionObject,
	parseCognitionResponse,
	extractJsonObject,
	emptyCognition,
	COGNITION_PROMPT_HASH,
} from "../../src/analyze/analyzers/assistant-cognition/prompt.js";
import { DEFAULT_ASSISTANT_COGNITION_CONFIG } from "../../src/analyze/analyzers/assistant-cognition/config.js";

const GROUNDS = {
	thinkingText: "The user wants a parser. Hmm, that's odd — the schema has no id field.",
	assistantText: "Let me check the schema. Actually, let's go back to approach A.",
};

describe("buildCognitionPrompt", () => {
	it("renders user text, thinking trace, and response text under separate labels", () => {
		const prompt = buildCognitionPrompt({
			userText: "add a parser",
			thinkingText: "thinking hard",
			assistantText: "speaking out loud",
		});
		assert.ok(prompt.includes("USER MESSAGE:"), "user label");
		assert.ok(prompt.includes("THINKING TRACE:"), "thinking label");
		assert.ok(prompt.includes("RESPONSE TEXT:"), "response label");
		assert.ok(prompt.includes("add a parser"));
		assert.ok(prompt.includes("thinking hard"));
		assert.ok(prompt.includes("speaking out loud"));
		const thinkingAt = prompt.indexOf("THINKING TRACE:");
		const responseAt = prompt.indexOf("RESPONSE TEXT:");
		assert.ok(thinkingAt < responseAt, "thinking trace precedes response text");
	});

	it("truncates each labeled section independently", () => {
		const long = "x".repeat(10_000);
		const prompt = buildCognitionPrompt({ userText: long, thinkingText: long, assistantText: long });
		assert.ok(prompt.length < 20_000, `prompt bounded, got ${prompt.length}`);
		assert.equal((prompt.match(/…/g) ?? []).length, 3, "each section truncated with ellipsis");
	});
});

describe("parseCognitionObject", () => {
	it("parses all three signal kinds from structured arguments", () => {
		const result = parseCognitionObject(
			{
				confusion: [{ level: "moderate", rationale: "re-reading the same file" }],
				indecision: [{ level: "high", rationale: "switched approach twice" }],
				surprise: [{ quote: "that's odd — the schema has no id field.", severity: "mild", rationale: "expected an id" }],
			},
			GROUNDS,
		);
		assert.equal(result.confusion.length, 1);
		assert.equal(result.indecision.length, 1);
		assert.equal(result.surprise.length, 1);
		assert.equal(result.surprise[0]!.quote, "that's odd — the schema has no id field.");
		assert.equal(result.surprise[0]!.severity, "mild");
	});

	it("drops entries with invalid levels or severities", () => {
		const result = parseCognitionObject(
			{
				confusion: [
					{ level: "extreme", rationale: "bad level" },
					{ level: "high", rationale: "" },
					{ level: "high" },
					{ level: "mild", rationale: "kept" },
				],
				indecision: [],
				surprise: [{ quote: "nope", severity: "catastrophic", rationale: "bad severity" }],
			},
			GROUNDS,
		);
		assert.deepEqual(result.confusion.map((e) => e.level), ["mild"]);
		assert.equal(result.indecision.length, 0);
		assert.equal(result.surprise.length, 0);
	});

	it("drops surprise entries whose quote is not an exact substring of thinking or response text", () => {
		const result = parseCognitionObject(
			{
				confusion: [],
				indecision: [],
				surprise: [
					// Paraphrase — not verbatim → rejected.
					{ quote: "the schema lacks an id", severity: "high", rationale: "paraphrased" },
					// Verbatim from the thinking trace → kept.
					{ quote: "Hmm, that's odd", severity: "moderate", rationale: "verbatim in thinking" },
					// Verbatim from the response text → kept.
					{ quote: "Actually, let's go back to approach A.", severity: "mild", rationale: "verbatim in response" },
					// Missing quote → rejected.
					{ severity: "high", rationale: "no quote at all" },
				],
			},
			GROUNDS,
		);
		assert.deepEqual(result.surprise.map((e) => e.quote), ["Hmm, that's odd", "Actually, let's go back to approach A."]);
	});

	it("treats empty arrays as valid abstention", () => {
		const result = parseCognitionObject({ confusion: [], indecision: [], surprise: [] }, GROUNDS);
		assert.deepEqual(result, emptyCognition());
	});

	it("returns abstention for missing arrays rather than throwing", () => {
		const result = parseCognitionObject({}, GROUNDS);
		assert.deepEqual(result, emptyCognition());
	});
});

describe("parseCognitionResponse (text path)", () => {
	it("parses fenced JSON", () => {
		const text = "Here is my analysis:\n```json\n{\"confusion\":[{\"level\":\"high\",\"rationale\":\"lost\"}],\"indecision\":[],\"surprise\":[]}\n```\nDone.";
		const result = parseCognitionResponse(text, GROUNDS);
		assert.equal(result.confusion.length, 1);
		assert.equal(result.confusion[0]!.level, "high");
	});

	it("throws when the text contains no JSON object", () => {
		assert.throws(() => parseCognitionResponse("I refuse to comply.", GROUNDS), /No JSON object/);
	});

	it("extractJsonObject handles nested braces", () => {
		const obj = extractJsonObject('{"a":{"b":1},"c":[2,3]}');
		assert.deepEqual(obj.a, { b: 1 });
		assert.deepEqual(obj.c, [2, 3]);
	});
});

describe("config defaults", () => {
	it("uses the cheap tier and gates on a non-trivial minimum thinking length", () => {
		assert.equal(DEFAULT_ASSISTANT_COGNITION_CONFIG.tier, "cheap");
		assert.ok(DEFAULT_ASSISTANT_COGNITION_CONFIG.minThinkingLength > 0);
	});
});

it("prompt hash is stable and non-empty", () => {
	assert.equal(COGNITION_PROMPT_HASH.length, 16);
});
