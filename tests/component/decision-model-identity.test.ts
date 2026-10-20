/**
 * The decision model and its question set are part of a node's recipe (#338):
 * switching turn-pair-llm from the generative path to a decision model marks the
 * earlier nodes stale for the `config` reason, and `--revise config` writes the
 * decision-model verdict beside the old one.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { createMockDecisionModel } from "../../src/analyze/mock-decision-model.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { turnPairLLMAnalyzer } from "../../src/analyze/analyzers/turn-pair-llm/index.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import type { DecisionAnswer } from "../../src/analyze/decision-model.js";

const GENERATIVE = JSON.stringify({
	sentiment: "frustrated",
	friction_type: "wrong_approach",
	is_genuine_correction: true,
	severity: "high",
	rationale: "user corrected the approach",
});

const ANSWERS: Record<string, DecisionAnswer> = {
	sentiment: { type: "choice", choice: "frustrated", confidence: 0.9, probabilities: { neutral: 0.05, frustrated: 0.93, positive: 0.02 } },
	friction_type: { type: "choice", choice: "wrong_approach", confidence: 0.8, probabilities: { none: 0.05, wrong_approach: 0.85, missed_instruction: 0.1 } },
	is_genuine_correction: { type: "noul", noul: 0.9 },
	severity: { type: "score", score: 1.9, confidence: 0.9, probabilities: { "0": 0.02, "1": 0.08, "2": 0.9 } },
};

async function seed(db: AsyncDatabase): Promise<void> {
	await insertSession(db, "s1");
	await insertMessages(db, "s1", [
		{ role: "user", text: "fix the login bug" },
		{ role: "assistant", text: "reading auth", toolCalls: [{ name: "read" }] },
		{ role: "toolResult", toolResults: [{ toolName: "read", isError: true, textLength: 80 }] },
		{ role: "user", text: "no, that's wrong, use the auth module instead" },
		{ role: "assistant", text: "understood, fixing now" },
	]);
}

async function framework(db: AsyncDatabase, decisionModel?: string) {
	const llm = createMockLLM({ fallback: GENERATIVE });
	const decision = createMockDecisionModel({ responder: () => ANSWERS, inputTokensPerCall: 400 });
	const fw = new AnalyzerFramework({
		db,
		llm: llm.caller,
		decide: decision.caller,
		modelTiers: DEFAULT_MODEL_TIERS,
		configOverrides: decisionModel ? { "turn-pair-llm": { decisionModel } } : undefined,
	});
	await fw.register(turnPairCoreAnalyzer);
	await fw.register(turnPairLLMAnalyzer);
	return { fw, llm, decision };
}

async function llmNodes(db: AsyncDatabase) {
	return (await db
		.prepare("SELECT content_json, model_used FROM analysis_nodes WHERE analyzer_id = 'turn-pair-llm' AND node_kind = 'classification' ORDER BY created_at, rowid")
		.all()) as Array<{ content_json: string; model_used: string }>;
}

describe("decision-model identity for turn-pair-llm", () => {
	it("marks generative nodes stale for config, and --revise config writes the decision verdict beside them", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db);
			await (await framework(db)).fw.run("s1");
			assert.equal((await llmNodes(db)).length, 1);

			const { fw, llm, decision } = await framework(db, "jev/jev-1.13.0");
			const scanned = (await fw.scan("s1")).filter((c) => c.analyzerId === "turn-pair-llm");
			assert.ok(scanned.length > 0 && scanned.every((c) => c.status === "stale" && c.reasons.includes("config")));

			const fill = await fw.run("s1");
			assert.equal(fill.nodesRevised, 0, "a plain fill leaves the generative node alone");
			assert.equal(decision.calls.length, 0);

			const revised = await fw.run("s1", { revise: ["config"] });
			assert.equal(revised.nodesRevised, 1);
			assert.equal(decision.calls.length, 1, "one request for the one turn");
			assert.equal(llm.calls.length, 0, "the decision path never calls the generative model");

			const nodes = await llmNodes(db);
			assert.equal(nodes.length, 2);
			const latest = JSON.parse(nodes[1]!.content_json) as Record<string, unknown>;
			assert.equal(latest["friction_type"], "wrong_approach");
			assert.equal(latest["severity"], "high");
			assert.ok(latest["probabilities"], "the distribution is stored as evidence");

			const again = await fw.run("s1", { revise: ["config"] });
			assert.equal(again.nodesProduced, 0, "re-running the decision path is idempotent");
		} finally {
			await close();
		}
	});

	it("a different decision model is a different recipe", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db);
			await (await framework(db, "jev/jev-1.13.0")).fw.run("s1");
			const { fw } = await framework(db, "jev/jev-1.14.0");
			const scanned = (await fw.scan("s1")).filter((c) => c.analyzerId === "turn-pair-llm");
			assert.ok(scanned.every((c) => c.status === "stale" && c.reasons.includes("config")));
		} finally {
			await close();
		}
	});
});
