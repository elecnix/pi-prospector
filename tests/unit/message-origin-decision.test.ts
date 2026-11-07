/**
 * The decision-model path of message-origin: two questions, composed in code.
 * `author` says who wrote the words and `copied` says whether the person wrote
 * them, so a human author with copied text is `pasted` and with new text `typed`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	HEAD_CHARS,
	ORIGIN_DECISION_QUESTIONS,
	TAIL_CHARS,
	originDecisionState,
	parseOriginDecision,
} from "../../src/analyze/analyzers/message-origin/decision.js";
import type { DecisionAnswer, DecisionResponse } from "../../src/analyze/decision-model.js";

function response(author: string, p: number, copied: number): DecisionResponse {
	const answers: Record<string, DecisionAnswer> = {
		author: { type: "choice", choice: author, confidence: p, probabilities: { [author]: p } },
		copied: { type: "noul", noul: copied },
	};
	return { answers, model: "m", costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 };
}

describe("parseOriginDecision", () => {
	it("composes the label from the two answers", () => {
		assert.equal(parseOriginDecision(response("human", 0.9, 0.1)).origin, "typed");
		assert.equal(parseOriginDecision(response("human", 0.9, 0.9)).origin, "pasted");
		assert.equal(parseOriginDecision(response("agent", 0.9, 0.9)).origin, "agent");
		assert.equal(parseOriginDecision(response("harness", 0.9, 0.1)).origin, "notification");
	});

	it("takes the confidence of the weakest answer the label rests on", () => {
		assert.equal(parseOriginDecision(response("human", 0.9, 0.55)).confidence, 0.55, "a pasted label rests on `copied`");
		assert.ok(Math.abs(parseOriginDecision(response("human", 0.9, 0.2)).confidence - 0.8) < 1e-9, "a typed label rests on `not copied`");
		assert.equal(parseOriginDecision(response("agent", 0.7, 0.99)).confidence, 0.7, "an agent label ignores `copied`");
	});

	it("asks one property per question", () => {
		assert.deepEqual(Object.keys(ORIGIN_DECISION_QUESTIONS), ["author", "copied"]);
		assert.deepEqual(Object.keys((ORIGIN_DECISION_QUESTIONS["author"] as { criteria: object }).criteria), ["human", "agent", "harness"]);
	});
});

describe("originDecisionState", () => {
	it("sends a short message whole", () => {
		assert.deepEqual(originDecisionState("  hello  "), { message: { text: "hello", shortened: false } });
	});

	it("sends the head and the tail of a long message, and says it was shortened", () => {
		const text = "a".repeat(HEAD_CHARS) + "b".repeat(5000) + "c".repeat(TAIL_CHARS);
		const { message } = originDecisionState(text);
		assert.equal(message.shortened, true);
		assert.ok(message.text.startsWith("a".repeat(HEAD_CHARS)));
		assert.ok(message.text.endsWith("c".repeat(TAIL_CHARS)));
		assert.ok(!message.text.includes("b".repeat(10)));
	});
});
