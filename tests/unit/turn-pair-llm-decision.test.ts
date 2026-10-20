/**
 * The decision-model path of turn-pair-llm (#338): with `decisionModel` set, one
 * request carries every question for the turn, and the answers map back onto the
 * classification fields the generative path writes. The generative caller must
 * never be reached.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { turnPairLLMAnalyzer } from "../../src/analyze/analyzers/turn-pair-llm/index.js";
import { DEFAULT_TURN_PAIR_LLM_CONFIG } from "../../src/analyze/analyzers/turn-pair-llm/config.js";
import { createMockDecisionModel } from "../../src/analyze/mock-decision-model.js";
import { createThrowingLLM } from "../../src/analyze/mock-llm.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import type { AnalysisUnit, AnalyzerRunContext } from "../../src/analyze/types.js";
import type { DecisionAnswer } from "../../src/analyze/decision-model.js";

const UNIT: AnalysisUnit = {
	sources: [{ kind: "analysis_node", id: "core-key" }],
	sourceSetHash: "ssh",
	anchorKind: "message",
	anchorRef: "u2",
	meta: {
		userText: "No, I asked you to run the tests before pushing. Run them now.",
		assistantText: "Pushed the branch.",
		correctionText: "No, I asked you",
		toolCalls: [{ name: "bash", argumentsPreview: "git push" }],
		toolResults: [],
		priorTurns: [],
		coreOutputKey: "core-key",
	},
};

const ANSWERS: Record<string, DecisionAnswer> = {
	sentiment: { type: "choice", choice: "frustrated", confidence: 0.9, probabilities: { positive: 0.02, neutral: 0.05, frustrated: 0.93 } },
	friction_type: {
		type: "choice",
		choice: "missed_instruction",
		confidence: 0.7,
		probabilities: { none: 0.05, wrong_approach: 0.1, missed_instruction: 0.75, tool_misuse: 0.05, repetition: 0.03, other: 0.02 },
	},
	is_genuine_correction: { type: "noul", noul: 0.88 },
	severity: { type: "score", score: 1.8, confidence: 0.8, probabilities: { "0": 0.05, "1": 0.1, "2": 0.85 } },
};

function runContext(decide: AnalyzerRunContext["decide"]): AnalyzerRunContext {
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
			analyzerId: "turn-pair-llm",
			configHash: "h",
			configJson: { ...DEFAULT_TURN_PAIR_LLM_CONFIG, decisionModel: "jev/jev-1.13.0" },
			label: "default",
		},
		prompts: {},
		modelTiers: DEFAULT_MODEL_TIERS,
	};
}

describe("turn-pair-llm decision-model path", () => {
	it("asks every question in one request and maps the answers onto the classification fields", async () => {
		const mock = createMockDecisionModel({ responder: () => ANSWERS, inputTokensPerCall: 500, costPerCall: 0.00002 });
		const result = await turnPairLLMAnalyzer.analyze(UNIT, runContext(mock.caller));

		assert.equal(mock.calls.length, 1, "one request per turn");
		const request = mock.calls[0]!;
		assert.equal(request.model, "jev/jev-1.13.0");
		assert.deepEqual(Object.keys(request.questions).sort(), ["friction_type", "is_genuine_correction", "sentiment", "severity"]);
		assert.equal(request.questions["sentiment"]!.type, "choice");
		assert.equal(request.questions["friction_type"]!.type, "choice");
		assert.equal(request.questions["is_genuine_correction"]!.type, "noul");
		assert.equal(request.questions["severity"]!.type, "score");

		const content = result.contentJson as Record<string, unknown>;
		assert.equal(content["sentiment"], "frustrated");
		assert.equal(content["friction_type"], "missed_instruction");
		assert.equal(content["is_genuine_correction"], true);
		assert.equal(content["severity"], "high");
		assert.equal(content["user_message_id"], "u2");
		assert.equal(result.costUsd, 0.00002);
		assert.equal(result.inputTokens, 500);
	});

	it("reads severity from the most probable level, not the mean score", async () => {
		const split = { ...ANSWERS, severity: { type: "score", score: 1.0, confidence: 0.1, probabilities: { "0": 0.45, "1": 0.1, "2": 0.45 } } as DecisionAnswer };
		const lowWins = { ...split, severity: { ...split["severity"]!, probabilities: { "0": 0.5, "1": 0.1, "2": 0.4 } } as DecisionAnswer };
		const mock = createMockDecisionModel({ responder: () => lowWins });
		const result = await turnPairLLMAnalyzer.analyze(UNIT, runContext(mock.caller));
		assert.equal((result.contentJson as Record<string, unknown>)["severity"], "low");
	});

	it("fails the unit when no decision-model client is wired", async () => {
		await assert.rejects(turnPairLLMAnalyzer.analyze(UNIT, runContext(undefined)) as Promise<unknown>, /decision model/i);
	});
});
