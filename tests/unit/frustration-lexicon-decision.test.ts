/**
 * The decision-model path of frustration-lexicon (#338): polarity, category and
 * language are Choices, and the polarity's probability replaces the
 * self-reported confidence. A neutral polarity still carries category "none".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { frustrationLexiconAnalyzer } from "../../src/analyze/analyzers/frustration-lexicon/index.js";
import { DEFAULT_FRUSTRATION_LEXICON_CONFIG } from "../../src/analyze/analyzers/frustration-lexicon/config.js";
import { createMockDecisionModel } from "../../src/analyze/mock-decision-model.js";
import { createThrowingLLM } from "../../src/analyze/mock-llm.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import type { AnalysisUnit, AnalyzerRunContext } from "../../src/analyze/types.js";
import type { DecisionAnswer, DecisionCaller } from "../../src/analyze/decision-model.js";

const UNIT: AnalysisUnit = {
	sources: [{ kind: "term", id: "encore" }],
	sourceSetHash: "ssh",
	anchorKind: "session",
	anchorRef: "s1",
	meta: { term: "encore" },
};

function ctx(decide: DecisionCaller): AnalyzerRunContext {
	return {
		sessionId: "s1",
		getMessage: async () => undefined,
		getNode: async () => undefined,
		getDependencyNodes: async () => [],
		getGlobalDependencyNodes: async () => [],
		getSessionMessages: async () => [],
		getSubagentRuns: async () => [],
		getTurnPairs: async () => [],
		llm: createThrowingLLM("the decision-model path must not call the generative model"),
		decide,
		config: {
			id: "c",
			analyzerId: "frustration-lexicon",
			configHash: "h",
			configJson: { ...DEFAULT_FRUSTRATION_LEXICON_CONFIG, decisionModel: "jev/jev-1.13.0" },
			label: "default",
		},
		prompts: {},
		modelTiers: DEFAULT_MODEL_TIERS,
	};
}

function choice(choice: string, p: number): DecisionAnswer {
	return { type: "choice", choice, confidence: p, probabilities: { [choice]: p } };
}

describe("frustration-lexicon decision-model path", () => {
	it("maps the three Choices and takes confidence from the polarity probability", async () => {
		const decision = createMockDecisionModel({
			responder: () => ({ polarity: choice("frustration", 0.82), category: choice("repetition", 0.7), language: choice("fr", 0.9) }),
		});
		const result = await frustrationLexiconAnalyzer.analyze(UNIT, ctx(decision.caller));
		const q = decision.calls[0]!.questions;
		assert.deepEqual(Object.keys(q).sort(), ["category", "language", "polarity"]);
		assert.deepEqual(decision.calls[0]!.state, { term: "encore" }, "the term is the whole input");
		const c = result.contentJson as Record<string, unknown>;
		assert.equal(c["polarity"], "frustration");
		assert.equal(c["category"], "repetition");
		assert.equal(c["language"], "fr");
		assert.equal(c["confidence"], 0.82);
		assert.equal(c["term"], "encore");
	});

	it("keeps category none for a neutral term", async () => {
		const decision = createMockDecisionModel({
			responder: () => ({ polarity: choice("neutral", 0.95), category: choice("repetition", 0.4), language: choice("und", 0.6) }),
		});
		const c = (await frustrationLexiconAnalyzer.analyze(UNIT, ctx(decision.caller))).contentJson as Record<string, unknown>;
		assert.equal(c["category"], "none");
	});
});
