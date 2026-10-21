/**
 * The decision-model path of the two speech acts named in issue #318 — the
 * user's **rebuttal** and the assistant's **apology**.
 *
 * Main added a decision-model path to turn-pair-llm and assistant-cognition
 * (#341). A new signal that only the generative path can produce is a signal
 * that vanishes the moment a run configures a decision model, so both speech
 * acts have to be reachable on that path too: the `rebuttal` friction type
 * becomes a criterion of the friction question, and the `apology` becomes a
 * question of its own beside surprise.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { turnPairLLMAnalyzer } from "../../src/analyze/analyzers/turn-pair-llm/index.js";
import { DEFAULT_TURN_PAIR_LLM_CONFIG } from "../../src/analyze/analyzers/turn-pair-llm/config.js";
import { assistantCognitionAnalyzer } from "../../src/analyze/analyzers/assistant-cognition/index.js";
import { DEFAULT_ASSISTANT_COGNITION_CONFIG } from "../../src/analyze/analyzers/assistant-cognition/config.js";
import { createMockDecisionModel } from "../../src/analyze/mock-decision-model.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import type { AnalysisUnit, AnalyzerRunContext } from "../../src/analyze/types.js";
import type { DecisionAnswer, DecisionCaller } from "../../src/analyze/decision-model.js";

const REBUTTAL_TEXT = "that's wrong, that flag doesn't exist";

const TURN_UNIT: AnalysisUnit = {
	sources: [{ kind: "analysis_node", id: "core-key" }],
	sourceSetHash: "ssh",
	anchorKind: "message",
	anchorRef: "u1",
	meta: {
		userText: REBUTTAL_TEXT,
		assistantText: "The --repo flag is the right one.",
		correctionText: "that's wrong",
		rebuttalCandidate: REBUTTAL_TEXT,
		toolCalls: [],
		toolResults: [],
		priorTurns: [],
		coreOutputKey: "core-key",
	},
};

const COGNITION_UNIT: AnalysisUnit = {
	sources: [{ kind: "analysis_node", id: "core-key" }],
	sourceSetHash: "ssh",
	anchorKind: "message",
	anchorRef: "u1",
	meta: {
		userText: "use the --repo flag",
		thinkingText: "The user wants the pull request opened against the right repository.",
		assistantText: "Sorry, my mistake — the flag is --repo, not --repository.",
		coreOutputKey: "core-key",
	},
};

function runContext(analyzerId: string, decide: DecisionCaller | undefined, llm: AnalyzerRunContext["llm"]): AnalyzerRunContext {
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
			analyzerId,
			configHash: "h",
			configJson: { decisionModel: "jev/jev-1.13.0" },
			label: "default",
		},
		prompts: {},
		modelTiers: DEFAULT_MODEL_TIERS,
	};
}

function score(probabilities: Record<string, number>): DecisionAnswer {
	const entries = Object.entries(probabilities);
	const top = entries.reduce((a, b) => (b[1] > a[1] ? b : a))[0]!;
	return { type: "score", score: Number(top), confidence: 0.8, probabilities };
}

function turnAnswers(choice: string): Record<string, DecisionAnswer> {
	return {
		sentiment: { type: "choice", choice: "frustrated", confidence: 0.9, probabilities: { positive: 0.02, neutral: 0.05, frustrated: 0.93 } },
		friction_type: {
			type: "choice",
			choice,
			confidence: 0.8,
			probabilities: { none: 0.05, wrong_approach: 0.1, missed_instruction: 0.05, tool_misuse: 0.02, repetition: 0.03, rebuttal: 0.7, other: 0.05 },
		},
		is_genuine_correction: { type: "noul", noul: 0.9 },
		severity: score({ "0": 0.05, "1": 0.15, "2": 0.8 }),
	};
}

describe("rebuttal on the turn-pair-llm decision-model path", () => {
	it("offers the friction question a rebuttal criterion", async () => {
		const mock = createMockDecisionModel({ responder: () => turnAnswers("rebuttal") });
		await turnPairLLMAnalyzer.analyze(TURN_UNIT, runContext("turn-pair-llm", mock.caller, createMockLLM({ fallback: "" }).caller));

		const question = mock.calls[0]!.questions["friction_type"]!;
		assert.equal(question.type, "choice");
		const criteria = (question as { criteria: Record<string, unknown> }).criteria;
		assert.ok(criteria["rebuttal"], "the friction question names a rebuttal criterion");
		assert.ok(
			!Object.keys(criteria).includes("missed_instruction_hint"),
			"the criterion set stays a flat map of option names",
		);
	});

	it("maps a rebuttal answer onto the stored friction type", async () => {
		const mock = createMockDecisionModel({ responder: () => turnAnswers("rebuttal") });
		const result = await turnPairLLMAnalyzer.analyze(
			TURN_UNIT,
			runContext("turn-pair-llm", mock.caller, createMockLLM({ fallback: "" }).caller),
		);
		assert.equal((result.contentJson as Record<string, unknown>)["friction_type"], "rebuttal");
	});

	it("carries the deterministic candidate into the state as a hint", async () => {
		const mock = createMockDecisionModel({ responder: () => turnAnswers("rebuttal") });
		await turnPairLLMAnalyzer.analyze(
			TURN_UNIT,
			runContext("turn-pair-llm", mock.caller, createMockLLM({ fallback: "" }).caller),
		);
		const state = mock.calls[0]!.state as Record<string, unknown>;
		assert.equal(state["rebuttal_candidate"], REBUTTAL_TEXT, "the candidate travels with the turn");
	});

	it("leaves the candidate out of the state when the wording matched nothing", async () => {
		const mock = createMockDecisionModel({ responder: () => turnAnswers("rebuttal") });
		const withoutCandidate: AnalysisUnit = {
			...TURN_UNIT,
			meta: { ...(TURN_UNIT.meta as Record<string, unknown>), rebuttalCandidate: null },
		};
		await turnPairLLMAnalyzer.analyze(
			withoutCandidate,
			runContext("turn-pair-llm", mock.caller, createMockLLM({ fallback: "" }).caller),
		);
		const state = mock.calls[0]!.state as Record<string, unknown>;
		assert.ok(!("rebuttal_candidate" in state), "no candidate, no hint");
	});
});

describe("apology on the assistant-cognition decision-model path", () => {
	it("asks an apology question and reads its answer", async () => {
		const mock = createMockDecisionModel({
			responder: () => ({
				confusion: score({ "0": 0.9, "1": 0.04, "2": 0.03, "3": 0.03 }),
				indecision: score({ "0": 0.9, "1": 0.04, "2": 0.03, "3": 0.03 }),
				surprise: { type: "noul", noul: 0.05 },
				surprise_severity: score({ "0": 0.9, "1": 0.04, "2": 0.03, "3": 0.03 }),
				apology: { type: "noul", noul: 0.95 },
				apology_severity: score({ "0": 0.05, "1": 0.15, "2": 0.15, "3": 0.65 }),
			}),
		});
		const llm = createMockLLM({ fallback: { structured: { quote: "Sorry, my mistake" } } });
		const result = await assistantCognitionAnalyzer.analyze(
			COGNITION_UNIT,
			runContext("assistant-cognition", mock.caller, llm.caller),
		);

		const questions = mock.calls[0]!.questions;
		assert.equal(questions["apology"]!.type, "noul", "the decision model is asked whether the turn carries an apology");
		const apology = (result.contentJson as Record<string, Array<Record<string, unknown>>>)["apology"]!;
		assert.equal(apology.length, 1, "an apology the decision model reports is stored");
		assert.equal(apology[0]!["severity"], "high");
		assert.equal(apology[0]!["quote"], "Sorry, my mistake");
	});

	it("drops an apology quote that is not verbatim in the response", async () => {
		const mock = createMockDecisionModel({
			responder: () => ({
				confusion: score({ "0": 0.9, "1": 0.04, "2": 0.03, "3": 0.03 }),
				indecision: score({ "0": 0.9, "1": 0.04, "2": 0.03, "3": 0.03 }),
				surprise: { type: "noul", noul: 0.05 },
				surprise_severity: score({ "0": 0.9, "1": 0.04, "2": 0.03, "3": 0.03 }),
				apology: { type: "noul", noul: 0.95 },
				apology_severity: score({ "0": 0.05, "1": 0.15, "2": 0.15, "3": 0.65 }),
			}),
		});
		const llm = createMockLLM({ fallback: { structured: { quote: "an invented sentence" } } });
		const result = await assistantCognitionAnalyzer.analyze(
			COGNITION_UNIT,
			runContext("assistant-cognition", mock.caller, llm.caller),
		);
		assert.deepEqual((result.contentJson as Record<string, unknown>)["apology"], []);
	});

	it("drops an apology quote that is only in the thinking trace", async () => {
		const mock = createMockDecisionModel({
			responder: () => ({
				confusion: score({ "0": 0.9, "1": 0.04, "2": 0.03, "3": 0.03 }),
				indecision: score({ "0": 0.9, "1": 0.04, "2": 0.03, "3": 0.03 }),
				surprise: { type: "noul", noul: 0.05 },
				surprise_severity: score({ "0": 0.9, "1": 0.04, "2": 0.03, "3": 0.03 }),
				apology: { type: "noul", noul: 0.95 },
				apology_severity: score({ "0": 0.05, "1": 0.15, "2": 0.15, "3": 0.65 }),
			}),
		});
		// The quote is in the thinking trace but not in the response: an apology is
		// something the user saw, so it never enters the graph.
		const llm = createMockLLM({ fallback: { structured: { quote: "the assistant wants the pull request opened" } } });
		const result = await assistantCognitionAnalyzer.analyze(
			COGNITION_UNIT,
			runContext("assistant-cognition", mock.caller, llm.caller),
		);
		assert.deepEqual((result.contentJson as Record<string, unknown>)["apology"], []);
	});
});
