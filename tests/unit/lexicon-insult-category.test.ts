/**
 * The `insult` category: a word that names or demeans the assistant or its work
 * is filed apart from profanity, on both the generative and the decision-model
 * paths.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import {
	CLASSIFY_TERM_PROMPT,
	CLASSIFY_TERM_TOOL,
	parseClassifyTermObject,
} from "../../src/analyze/analyzers/frustration-lexicon/prompt.js";
import { TERM_DECISION_QUESTIONS } from "../../src/analyze/analyzers/frustration-lexicon/decision.js";

const INSULT_VERDICT = {
	polarity: "frustration",
	category: "insult",
	language: "en",
	confidence: 0.9,
	rationale: "demeans the assistant",
};

describe("frustration-lexicon insult category", () => {
	it("the parser keeps `insult` instead of folding it to `none`", () => {
		assert.equal(parseClassifyTermObject(INSULT_VERDICT).category, "insult");
	});

	it("the prompt offers `insult` and says how it differs from profanity", () => {
		assert.match(CLASSIFY_TERM_PROMPT, /"profanity" \| "insult" \|/);
		assert.match(CLASSIFY_TERM_PROMPT, /"insult" names or demeans the assistant/);
	});

	it("the forced tool call accepts `insult`", () => {
		assert.equal(Value.Check(CLASSIFY_TERM_TOOL.parameters, INSULT_VERDICT), true);
	});

	it("the decision model can answer `insult`", () => {
		const criteria = (TERM_DECISION_QUESTIONS["category"] as { criteria: Record<string, unknown> }).criteria;
		assert.ok(criteria["insult"], "the category Choice lists insult");
	});
});
