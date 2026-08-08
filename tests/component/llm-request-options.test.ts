/**
 * Analyzers own their own thinking level, and a misconfigured model fails once.
 *
 * Thinking is an analyzer-level decision, not a global one: judging a single
 * lexicon word wants none, while a session synthesis may want plenty. So the
 * level travels on the request, set by the analyzer, rather than as a run-wide
 * flag.
 *
 * The fail-fast case comes from a real incident: a model spec missing its
 * provider prefix produced *113,992* identical error nodes in five seconds —
 * one per unit — for a single root cause that was knowable before the first
 * unit ran.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { lexiconCandidatesAnalyzer } from "../../src/analyze/analyzers/lexicon-candidates/index.js";
import { frustrationLexiconAnalyzer, FRUSTRATION_LEXICON_DEF } from "../../src/analyze/analyzers/frustration-lexicon/index.js";
import { DEFAULT_FRUSTRATION_LEXICON_CONFIG } from "../../src/analyze/analyzers/frustration-lexicon/config.js";
import { getNodesByAnalyzer } from "../../src/db/analysis-queries.js";
import type { LLMRequest } from "../../src/analyze/types.js";

function verdict() {
	return {
		text: "x",
		structured: { polarity: "neutral", category: "none", language: "und", confidence: 0.9, rationale: "r" },
	};
}

describe("analyzer-owned reasoning level", () => {
	it("the lexicon asks for no thinking — the task does not need any", () => {
		assert.equal(
			DEFAULT_FRUSTRATION_LEXICON_CONFIG.reasoning,
			"off",
			"judging one word is not a reasoning task, and reasoning tokens are billed as output",
		);
	});

	it("carries the analyzer's level through to the request", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			insertMessages(db, "s1", [{ role: "user", text: "putain" }]);

			const llm = createMockLLM({ responder: verdict });
			const framework = new AnalyzerFramework({ db, llm: llm.caller, modelTiers: DEFAULT_MODEL_TIERS });
			framework.register(lexiconCandidatesAnalyzer);
			framework.register(frustrationLexiconAnalyzer);
			await framework.run("s1");

			const termCalls = llm.calls.filter((c: LLMRequest) => c.tool?.name === "classify_term");
			assert.ok(termCalls.length > 0);
			assert.equal(termCalls.every((c) => c.reasoning === "off"), true);
		} finally {
			close();
		}
	});

	it("honours a per-analyzer override of the level", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			insertMessages(db, "s1", [{ role: "user", text: "putain" }]);

			const llm = createMockLLM({ responder: verdict });
			const framework = new AnalyzerFramework({
				db,
				llm: llm.caller,
				modelTiers: DEFAULT_MODEL_TIERS,
				configOverrides: { [FRUSTRATION_LEXICON_DEF.id]: { reasoning: "low" } },
			});
			framework.register(lexiconCandidatesAnalyzer);
			framework.register(frustrationLexiconAnalyzer);
			await framework.run("s1");

			const termCalls = llm.calls.filter((c: LLMRequest) => c.tool?.name === "classify_term");
			assert.equal(termCalls.every((c) => c.reasoning === "low"), true);
		} finally {
			close();
		}
	});
});

describe("failing fast on a broken model configuration", () => {
	it("stops after the first unit instead of writing one error per unit", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			// Plenty of distinct vocabulary, so a per-unit failure would be very visible.
			insertMessages(db, "s1", [{ role: "user", text: Array.from({ length: 60 }, (_, i) => `word${String.fromCharCode(97 + i % 26)}${String.fromCharCode(97 + Math.floor(i / 26))}`).join(" ").replace(/\d/g, "") }]);

			let calls = 0;
			const llm = async () => {
				calls++;
				throw new Error("Model not found in Pi registry: inclusionai/ling-2.6-flash. Configure it via Pi or set modelTiers in prospector.json.");
			};
			const framework = new AnalyzerFramework({ db, llm, modelTiers: DEFAULT_MODEL_TIERS });
			framework.register(lexiconCandidatesAnalyzer);
			framework.register(frustrationLexiconAnalyzer);
			const summary = await framework.run("s1");

			assert.ok(summary.errors.length > 0, "the failure is reported");
			assert.equal(calls, 1, "the model is only asked once — the fault is not per-unit");
			const errorNodes = getNodesByAnalyzer(db, FRUSTRATION_LEXICON_DEF.id, "s1").filter((n) => n.node_kind === "error");
			assert.ok(errorNodes.length <= 1, `expected at most one error node, got ${errorNodes.length}`);
		} finally {
			close();
		}
	});

	it("keeps going when a failure is genuinely per-unit", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			insertMessages(db, "s1", [{ role: "user", text: "alpha bravo charlie delta" }]);

			let calls = 0;
			const llm = async (req: LLMRequest) => {
				calls++;
				// Only one particular term fails; the rest must still be judged.
				if (req.user.includes("bravo")) throw new Error("429 rate limited");
				return {
					text: "x",
					structured: { polarity: "neutral", category: "none", language: "und", confidence: 0.9, rationale: "r" },
					model: "m",
					costUsd: 0,
					tokensUsed: 0,
					durationMs: 0,
					stopReason: "stop",
				};
			};
			const framework = new AnalyzerFramework({ db, llm, modelTiers: DEFAULT_MODEL_TIERS });
			framework.register(lexiconCandidatesAnalyzer);
			framework.register(frustrationLexiconAnalyzer);
			const summary = await framework.run("s1");

			assert.ok(calls > 2, "a single unit's failure does not abort the analyzer");
			assert.ok(summary.nodesProduced > 1, "the other terms were still judged");
		} finally {
			close();
		}
	});
});
