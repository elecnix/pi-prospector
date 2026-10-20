/**
 * The decision-model path of user-reply-acts (#338). Code splits the reply into
 * numbered sentences; one request asks a Noul per act class and, speculatively,
 * a Choice over the sentence ids for its quote. The quote is a sentence of the
 * reply, so it is verbatim by construction and no generative call is made.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import analyzer from "../../.prospector/analyzers/user-reply-acts.analyzer.js";
import { splitReplySentences } from "../../.prospector/analyzers/user-reply-acts-decision.js";
import { createMockDecisionModel } from "../../src/analyze/mock-decision-model.js";
import { createThrowingLLM } from "../../src/analyze/mock-llm.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import type { AnalysisUnit, AnalyzerRunContext } from "../../src/analyze/types.js";
import type { DecisionAnswer, DecisionCaller, DecisionRequest } from "../../src/analyze/decision-model.js";

const REPLY = "Yes, go ahead with the parser. Which file holds the schema? Also keep the old flag.";

const UNIT: AnalysisUnit = {
	sources: [{ kind: "message", id: "u2" }],
	sourceSetHash: "ssh",
	anchorKind: "message",
	anchorRef: "u2",
	meta: {
		priorAssistantText: "I can add a parser for the config format. Shall I go ahead?",
		userText: REPLY,
		priorUserMessageId: "u1",
		priorCoreOutputKey: "core-key",
		pairIndex: 1,
	},
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
		config: { id: "c", analyzerId: "user-reply-acts", configHash: "h", configJson: { ...analyzer.defaultConfig.configJson, decisionModel: "jev/jev-1.13.0" }, label: "default" },
		prompts: {},
		modelTiers: DEFAULT_MODEL_TIERS,
	};
}

const noul = (p: number): DecisionAnswer => ({ type: "noul", noul: p });
const choice = (c: string): DecisionAnswer => ({ type: "choice", choice: c, confidence: 0.9, probabilities: { [c]: 0.95 } });

function respond(request: DecisionRequest): Record<string, DecisionAnswer> {
	const out: Record<string, DecisionAnswer> = {};
	for (const [name, q] of Object.entries(request.questions)) {
		if (q.type === "noul") out[name] = noul(0.05);
		else out[name] = choice(Object.keys(q.criteria as Record<string, unknown>)[0]!);
	}
	out["acceptance"] = noul(0.95);
	out["acceptance_quote"] = choice("S1");
	out["acceptance_level"] = choice("full");
	out["question"] = noul(0.9);
	out["question_quote"] = choice("S2");
	out["question_purpose"] = choice("information");
	out["command"] = noul(0.8);
	out["command_quote"] = choice("S3");
	out["continuation"] = noul(0.7);
	return out;
}

describe("splitReplySentences", () => {
	it("splits on sentence ends and lines, keeping each piece verbatim", () => {
		const parts = splitReplySentences("first line\nSecond one. Third? Fourth!");
		assert.deepEqual(parts, ["first line", "Second one.", "Third?", "Fourth!"]);
	});
});

describe("user-reply-acts decision-model path", () => {
	it("asks every question in one request and quotes the chosen sentence verbatim", async () => {
		const decision = createMockDecisionModel({ responder: respond });
		const result = await analyzer.analyze(UNIT, ctx(decision.caller));
		assert.equal(decision.calls.length, 1);
		assert.equal(decision.calls[0]!.questions["acceptance"]!.type, "noul");
		assert.equal(decision.calls[0]!.questions["acceptance_quote"]!.type, "choice");

		const c = result.contentJson as Record<string, unknown>;
		assert.deepEqual(c["acceptances"], [{ level: "full", quote: "Yes, go ahead with the parser.", rationale: "" }]);
		assert.deepEqual(c["questions"], [{ purpose: "information", quote: "Which file holds the schema?", rationale: "" }]);
		assert.deepEqual(c["commands"], [{ quote: "Also keep the old flag.", rationale: "" }]);
		assert.deepEqual(c["refusals"], []);
		assert.equal(c["continuation"], false, "continuation means no act; acts override it");
		assert.equal(c["other"], false);
		assert.equal(c["user_message_id"], "u2");
		assert.equal(c["prior_core_output_key"], "core-key");
		for (const key of ["acceptances", "questions", "commands"]) {
			for (const act of c[key] as Array<{ quote: string }>) assert.ok(REPLY.includes(act.quote));
		}
	});

	it("records other when the decision model says so and the reply carries no act", async () => {
		const decision = createMockDecisionModel({
			responder: (request) => {
				const out = respond(request);
				for (const k of ["acceptance", "question", "command", "continuation"]) out[k] = noul(0.1);
				out["other"] = noul(0.8);
				return out;
			},
		});
		const c = (await analyzer.analyze(UNIT, ctx(decision.caller))).contentJson as Record<string, unknown>;
		assert.equal(c["other"], true);
		assert.deepEqual(c["acceptances"], []);
	});
});
