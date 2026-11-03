/**
 * Component tests for the prompt-form analyzer, exercised end-to-end through the
 * real AnalyzerFramework with its dependencies. Hand-written synthetic rows. The
 * classifier is a mock decision model, so no network and no paid call.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages, readAnalyzerNodes, nodeEdges, type TestMessage } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { createThrowingLLM } from "../../src/analyze/mock-llm.js";
import { createMockDecisionModel } from "../../src/analyze/mock-decision-model.js";
import { messageOriginAnalyzer } from "../../src/analyze/analyzers/message-origin/index.js";
import { messageAnswersAnalyzer, MESSAGE_ANSWERS_DEF } from "../../src/analyze/analyzers/message-answers/index.js";
import { promptFormAnalyzer, type PromptFormProperties } from "../../src/analyze/analyzers/prompt-form/index.js";
import type { DecisionAnswer, DecisionRequest } from "../../src/analyze/decision-model.js";

function conversation(): TestMessage[] {
	return [
		{ role: "user", text: "Please fix the failing build." },
		{ role: "assistant", text: "Fixed." },
		{ role: "user", text: "why did it fail in the first place" },
		{ role: "assistant", text: "A missing import." },
		{ role: "user", text: "- add a test\n- run the suite\n- report the result" },
		{ role: "assistant", text: "Done." },
	];
}

/** The mock classifier: no question mark is ever read, the text decides. */
function classify(request: DecisionRequest): Record<string, DecisionAnswer> {
	const state = request.state as { message: { text: string } };
	const choice = /^why/i.test(state.message.text) ? "question" : "instruction";
	const out: Record<string, DecisionAnswer> = {};
	for (const key of Object.keys(request.questions)) {
		out[key] = { type: "choice", choice, confidence: 0.9, probabilities: { [choice]: 0.9 } };
	}
	return out;
}

async function run(db: Parameters<typeof insertSession>[0], id: string, messages: TestMessage[], decisionModel: string | null = "jev/jev-1.13.0") {
	await insertSession(db, id);
	await insertMessages(db, id, messages);
	const model = createMockDecisionModel({ responder: classify });
	const fw = new AnalyzerFramework({
		db,
		llm: createThrowingLLM("prompt-form must not call the generative model"),
		decide: model.caller,
		modelTiers: DEFAULT_MODEL_TIERS,
		configOverrides: decisionModel ? { [MESSAGE_ANSWERS_DEF.id]: { decisionModel } } : undefined,
	});
	await fw.register(messageOriginAnalyzer);
	await fw.register(messageAnswersAnalyzer);
	await fw.register(promptFormAnalyzer);
	const summary = await fw.run(id, {});
	assert.equal(summary.errors.length, 0, summary.errors.join("; "));
	return { fw, model };
}

describe("prompt-form component test", () => {
	it("folds the typed prompts by the classifier's kinds and consumes the origin and answer nodes", async () => {
		const { db, close } = await tempDb();
		try {
			await run(db, "pf-1", conversation());
			const nodes = await readAnalyzerNodes(db, "prompt-form");
			assert.equal(nodes.length, 1);
			const content = JSON.parse(nodes[0]!.content_json) as PromptFormProperties;
			assert.equal(content.typed_message_count, 3);
			assert.deepEqual(content.kinds, { question: 1, instruction: 2, correction: 0, other: 0, unknown: 0 }, "a question without a question mark is a question");
			assert.equal(content.list_count, 1);

			const edges = await nodeEdges(db, nodes[0]!.id);
			assert.equal(edges.filter((e) => e["edge_kind"] === "anchors" && e["to_ref_kind"] === "session").length, 1);
			assert.equal(edges.filter((e) => e["edge_kind"] === "consumes").length, 6, "three origin nodes and three answer nodes");
			const proposals = (await db.prepare("SELECT COUNT(*) AS c FROM proposals WHERE analyzer_id = 'prompt-form'").get()) as unknown as { c: number };
			assert.equal(proposals.c, 0);
		} finally {
			await close();
		}
	});

	it("reports every kind as unknown, not zero, when no decision model is configured", async () => {
		const { db, close } = await tempDb();
		try {
			const { model } = await run(db, "pf-nomodel", conversation(), null);
			assert.equal(model.calls.length, 0);
			const content = JSON.parse((await readAnalyzerNodes(db, "prompt-form"))[0]!.content_json) as PromptFormProperties;
			assert.deepEqual(content.kinds, { question: 0, instruction: 0, correction: 0, other: 0, unknown: 3 });
		} finally {
			await close();
		}
	});

	it("does not read a prompt another agent wrote", async () => {
		const { db, close } = await tempDb();
		try {
			await run(db, "pf-agent", [
				{ role: "user", text: "Do the task." },
				{ role: "assistant", text: "Working." },
				{ role: "user", text: "<system-reminder>The task tool was not used recently.</system-reminder>" },
				{ role: "assistant", text: "Noted." },
			]);
			const content = JSON.parse((await readAnalyzerNodes(db, "prompt-form"))[0]!.content_json) as PromptFormProperties;
			assert.equal(content.typed_message_count, 1);
		} finally {
			await close();
		}
	});

	it("a plain re-run is a no-op fill and sends nothing to the classifier", async () => {
		const { db, close } = await tempDb();
		try {
			const { fw, model } = await run(db, "pf-rerun", conversation());
			const before = (await readAnalyzerNodes(db, "prompt-form")).map((n) => n.output_key);
			const sent = model.calls.length;
			await fw.run("pf-rerun", {});
			assert.deepEqual((await readAnalyzerNodes(db, "prompt-form")).map((n) => n.output_key), before);
			assert.equal(model.calls.length, sent);
		} finally {
			await close();
		}
	});

	it("gives a session with no user-role message a zero-count node", async () => {
		const { db, close } = await tempDb();
		try {
			await run(db, "pf-agent-only", [
				{ role: "assistant", text: "Scheduled run started." },
				{ role: "assistant", text: "Scheduled run finished." },
			]);
			const nodes = await readAnalyzerNodes(db, "prompt-form");
			assert.equal(nodes.length, 1);
			assert.equal((JSON.parse(nodes[0]!.content_json) as PromptFormProperties).typed_message_count, 0);
		} finally {
			await close();
		}
	});

	it("plans nothing for an empty transcript", async () => {
		const { db, close } = await tempDb();
		try {
			await run(db, "pf-empty", []);
			assert.equal((await readAnalyzerNodes(db, "prompt-form")).length, 0);
		} finally {
			await close();
		}
	});
});
