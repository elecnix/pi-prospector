/**
 * The decision-model path of assistant-cognition (#338): confusion and
 * indecision are Scores with a "none" level, surprise is a Noul with a severity
 * Score beside it, and only a turn the decision model judges surprised pays for
 * a generative call, which extracts the verbatim quote.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assistantCognitionAnalyzer } from "../../src/analyze/analyzers/assistant-cognition/index.js";
import { DEFAULT_ASSISTANT_COGNITION_CONFIG } from "../../src/analyze/analyzers/assistant-cognition/config.js";
import { createMockDecisionModel } from "../../src/analyze/mock-decision-model.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import type { AnalysisUnit, AnalyzerRunContext, LLMCaller } from "../../src/analyze/types.js";
import type { DecisionAnswer, DecisionCaller } from "../../src/analyze/decision-model.js";

const THINKING = "The user wants a parser. Hmm, that's odd — the schema has no id field. Let me look again.";

const UNIT: AnalysisUnit = {
	sources: [{ kind: "analysis_node", id: "core-key" }],
	sourceSetHash: "ssh",
	anchorKind: "message",
	anchorRef: "u1",
	meta: { userText: "add a parser", thinkingText: THINKING, assistantText: "Checking the schema.", coreOutputKey: "core-key" },
};

function score(top: number): DecisionAnswer {
	const probabilities: Record<string, number> = { "0": 0.05, "1": 0.05, "2": 0.05, "3": 0.05 };
	probabilities[String(top)] = 0.85;
	return { type: "score", score: top, confidence: 0.8, probabilities };
}

function answers(surprise: number): Record<string, DecisionAnswer> {
	return {
		confusion: score(2),
		indecision: score(0),
		surprise: { type: "noul", noul: surprise },
		surprise_severity: score(1),
	};
}

function ctx(decide: DecisionCaller, llm: LLMCaller): AnalyzerRunContext {
	return {
		sessionId: "s1",
		getMessage: async () => undefined,
		getNode: async () => undefined,
		getDependencyNodes: async () => [],
		getGlobalDependencyNodes: async () => [],
		getSessionMessages: async () => [],
		getSubagentRuns: async () => [],
		getTurnPairs: async () => [],
		llm,
		decide,
		config: {
			id: "c",
			analyzerId: "assistant-cognition",
			configHash: "h",
			configJson: { ...DEFAULT_ASSISTANT_COGNITION_CONFIG, decisionModel: "jev/jev-1.13.0" },
			label: "default",
		},
		prompts: {},
		modelTiers: DEFAULT_MODEL_TIERS,
	};
}

describe("assistant-cognition decision-model path", () => {
	it("maps Score levels to graded entries and makes no generative call without surprise", async () => {
		const decision = createMockDecisionModel({ responder: () => answers(0.1) });
		const llm = createMockLLM({ fallback: "" });
		const result = await assistantCognitionAnalyzer.analyze(UNIT, ctx(decision.caller, llm.caller));

		assert.equal(decision.calls.length, 1);
		const q = decision.calls[0]!.questions;
		assert.equal(q["confusion"]!.type, "score");
		assert.equal(q["indecision"]!.type, "score");
		assert.equal(q["surprise"]!.type, "noul");
		assert.equal(llm.calls.length, 0, "no quote extraction when the turn shows no surprise");

		const c = result.contentJson as Record<string, Array<Record<string, unknown>>>;
		assert.deepEqual(c["confusion"]!.map((e) => e["level"]), ["moderate"]);
		assert.deepEqual(c["indecision"], [], "the none level is no entry");
		assert.deepEqual(c["surprise"], []);
	});

	it("extracts a verbatim quote with one generative call when the turn shows surprise", async () => {
		const decision = createMockDecisionModel({ responder: () => answers(0.9) });
		const llm = createMockLLM({ fallback: { structured: { quote: "that's odd — the schema has no id field" } } });
		const result = await assistantCognitionAnalyzer.analyze(UNIT, ctx(decision.caller, llm.caller));

		assert.equal(llm.calls.length, 1);
		const surprise = (result.contentJson as Record<string, Array<Record<string, unknown>>>)["surprise"]!;
		assert.equal(surprise.length, 1);
		assert.equal(surprise[0]!["quote"], "that's odd — the schema has no id field");
		assert.equal(surprise[0]!["severity"], "mild");
	});

	it("drops a surprise whose quote is not in the turn", async () => {
		const decision = createMockDecisionModel({ responder: () => answers(0.9) });
		const llm = createMockLLM({ fallback: { structured: { quote: "an invented sentence" } } });
		const result = await assistantCognitionAnalyzer.analyze(UNIT, ctx(decision.caller, llm.caller));
		assert.deepEqual((result.contentJson as Record<string, unknown>)["surprise"], []);
	});
});
