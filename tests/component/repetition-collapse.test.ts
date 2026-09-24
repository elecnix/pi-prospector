/**
 * Component tests for the repetition-collapse analyzer, exercised end-to-end
 * through the real AnalyzerFramework (issue #278). No real session data, no
 * network: hand-written synthetic rows. The analyzer never touches the LLM
 * seam; the mock LLM exists only to satisfy the framework's construction.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	tempDb,
	insertSession,
	insertMessages,
	mockFramework,
	readAnalyzerNodes,
	nodeEdges,
	sessionProposals,
	runAnalyzerOverSession,
	expectPlainRerunIsNoOpFill,
	expectConfigChangeRevises,
	type TestMessage,
} from "./helpers.js";
import { repetitionCollapseAnalyzer } from "../../src/analyze/analyzers/repetition-collapse/index.js";
import { routingOpportunityAnalyzer, type RoutingProperties } from "../../src/analyze/analyzers/routing-opportunity/index.js";

const ANALYZER_ID = "repetition-collapse";

const SUBWORD_LOOP = "TestGet" + "Custom".repeat(2000);
const SENTENCE_LOOP = "I realize I've been polling for a while. Let me just proceed with the next step. ".repeat(60);
const LONG_ANALYSIS = Array.from(
	{ length: 120 },
	(_, i) => `Line ${i} checks value ${i * i} against bound ${i * 3 + 1}.`,
).join(" ");

/** One ordinary long step, and one that loops sub-word and returns nothing. */
function collapsedSession(): TestMessage[] {
	return [
		{ role: "user", text: "Why does the custom test fail?" },
		{ role: "assistant", thinking: LONG_ANALYSIS, text: "The bound check is off by one.", model: "model-a", costUsd: 0.05 },
		{ role: "user", text: "Write the test for it." },
		{ role: "assistant", thinking: SUBWORD_LOOP, text: "", model: "model-a", costUsd: 1.25, stopReason: "length" },
	];
}

/** A step that loops on a sentence but still acts: recorded, never proposed on. */
function deliveredSession(): TestMessage[] {
	return [
		{ role: "user", text: "Is CI done?" },
		{ role: "assistant", thinking: SENTENCE_LOOP, toolCalls: [{ name: "bash", arguments: { command: "gh run list" } }], model: "model-b" },
	];
}

/** Long analyses only: judged, nothing loops. */
function cleanSession(): TestMessage[] {
	return [
		{ role: "user", text: "Check the bounds." },
		{ role: "assistant", thinking: LONG_ANALYSIS, text: "All bounds hold." },
	];
}

describe("repetition-collapse component test", () => {
	it("flags a looping step that delivered nothing and materialises a routing proposal", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "rc-e2e");
			const ids = await insertMessages(db, "rc-e2e", collapsedSession());

			const fw = mockFramework(db);
			await fw.register(repetitionCollapseAnalyzer);
			const summary = await fw.run("rc-e2e", {});
			assert.equal(summary.errors.length, 0, `run should have no errors: ${summary.errors.join("; ")}`);

			const nodes = await readAnalyzerNodes(db, ANALYZER_ID);
			assert.equal(nodes.length, 1, "one session-level node");
			assert.equal(nodes[0]!.node_kind, "proposal");

			const content = JSON.parse(nodes[0]!.content_json) as {
				judged_step_count: number;
				collapsed: Array<{ message_id: string; user_message_id: string; channel: string; delivered: boolean; stop_reason: string | null; measure: { word: number; char: number; motif: string } }>;
				undelivered_step_count: number;
				undelivered_cost_usd: number | null;
			};
			assert.equal(content.judged_step_count, 2, "the long analysis is judged too — length is not the trigger");
			assert.equal(content.collapsed.length, 1);
			const c = content.collapsed[0]!;
			assert.equal(c.message_id, ids[3]);
			assert.equal(c.user_message_id, ids[2]);
			assert.equal(c.channel, "reasoning");
			assert.equal(c.delivered, false);
			assert.equal(c.stop_reason, "length");
			assert.equal(c.measure.word, 0, "a sub-word loop is invisible to the word measure");
			assert.ok(c.measure.char > 0.99);
			assert.equal(c.measure.motif, "Custom");
			assert.equal(content.undelivered_step_count, 1);
			assert.equal(content.undelivered_cost_usd, 1.25);
			assert.ok(!nodes[0]!.content_json.includes("CustomCustom"), "the looping text itself never enters the graph");

			const edges = await nodeEdges(db, nodes[0]!.id);
			assert.equal(edges.filter((e) => e["edge_kind"] === "anchors" && e["to_ref_kind"] === "session").length, 1);
			assert.deepEqual(
				edges.filter((e) => e["edge_kind"] === "anchors" && e["to_ref_kind"] === "message").map((e) => e["to_ref_id"]),
				[ids[3]],
				"anchored to the step that looped",
			);
			assert.ok(edges.find((e) => e["edge_kind"] === "produces"));

			const proposals = await sessionProposals(db, "rc-e2e", ANALYZER_ID);
			assert.equal(proposals.length, 1);
			assert.match(String(proposals[0]!.title), /1 step looped on repeated text and delivered nothing/);
			assert.equal(proposals[0]!.target_type, "config");
			assert.equal(proposals[0]!.severity, "waste");
		} finally {
			await close();
		}
	});

	it("a looping step that still called a tool is recorded as a metric with no proposal", async () => {
		const { db, close } = await tempDb();
		try {
			const nodes = await runAnalyzerOverSession(db, repetitionCollapseAnalyzer, "rc-delivered", deliveredSession());
			assert.equal(nodes.length, 1);
			assert.equal(nodes[0]!.node_kind, "metric");
			const content = JSON.parse(nodes[0]!.content_json) as {
				collapsed: Array<{ delivered: boolean; measure: { word: number; char: number } }>;
				undelivered_step_count: number;
				undelivered_cost_usd: number | null;
			};
			assert.equal(content.collapsed.length, 1);
			assert.equal(content.collapsed[0]!.delivered, true);
			assert.ok(content.collapsed[0]!.measure.word > 0.9, "a sentence loop is the word measure's case");
			assert.equal(content.undelivered_step_count, 0);
			assert.equal(content.undelivered_cost_usd, null, "no undelivered step, so no cost — never a synthetic 0");
		} finally {
			await close();
		}
	});

	it("a long session that never loops is a clean metric node", async () => {
		const { db, close } = await tempDb();
		try {
			const nodes = await runAnalyzerOverSession(db, repetitionCollapseAnalyzer, "rc-clean", cleanSession());
			assert.equal(nodes.length, 1);
			assert.equal(nodes[0]!.node_kind, "metric");
			const content = JSON.parse(nodes[0]!.content_json) as { judged_step_count: number; collapsed: unknown[] };
			assert.equal(content.judged_step_count, 1);
			assert.equal(content.collapsed.length, 0);
		} finally {
			await close();
		}
	});

	it("a session with no step long enough to judge plans no unit", async () => {
		const { db, close } = await tempDb();
		try {
			const nodes = await runAnalyzerOverSession(db, repetitionCollapseAnalyzer, "rc-short", [
				{ role: "user", text: "hi" },
				{ role: "assistant", thinking: "-_".repeat(50), text: "hello" },
			]);
			assert.equal(nodes.length, 0);
		} finally {
			await close();
		}
	});

	it("re-running the same recipe is idempotent", async () => {
		const { db, close } = await tempDb();
		try {
			await expectPlainRerunIsNoOpFill(db, repetitionCollapseAnalyzer, "rc-idem", collapsedSession());
		} finally {
			await close();
		}
	});

	it("raising repetitionThreshold marks the node stale for `config` and revises beside it", async () => {
		const { db, close } = await tempDb();
		try {
			const { before, after } = await expectConfigChangeRevises(db, repetitionCollapseAnalyzer, "rc-config", collapsedSession(), {
				repetitionThreshold: 1,
			});
			assert.equal(before[0]!.node_kind, "proposal");
			const newNode = after.find((n) => n.input_key !== before[0]!.input_key);
			assert.ok(newNode);
			assert.equal(newNode!.node_kind, "metric", "nothing reaches a threshold of 1 exactly");
		} finally {
			await close();
		}
	});

	it("routing-opportunity escalates the turn whose step looped, and only that turn", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "rc-routing");
			const ids = await insertMessages(db, "rc-routing", collapsedSession());

			const fw = mockFramework(db);
			await fw.register(repetitionCollapseAnalyzer);
			await fw.register(routingOpportunityAnalyzer);
			const summary = await fw.run("rc-routing", {});
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			const [collapse] = await readAnalyzerNodes(db, ANALYZER_ID);
			const routing = (await readAnalyzerNodes(db, "routing-opportunity")).map((n) => ({
				node: n,
				props: JSON.parse(n.content_json) as RoutingProperties,
			}));
			const byUser = new Map(routing.map((r) => [r.props.user_message_id, r]));
			const looped = byUser.get(ids[2]!)!;
			const clean = byUser.get(ids[0]!)!;
			assert.equal(looped.props.features.repetition_collapse, true);
			assert.equal(looped.props.verdict, "escalate");
			assert.equal(clean.props.features.repetition_collapse, false);

			const consumed = async (nodeId: string): Promise<unknown[]> =>
				(await nodeEdges(db, nodeId)).filter((e) => e["edge_kind"] === "consumes").map((e) => e["to_ref_id"]);
			assert.ok((await consumed(looped.node.id)).includes(collapse!.output_key), "the escalated turn consumes the collapse node");
			assert.ok(!(await consumed(clean.node.id)).includes(collapse!.output_key), "an untouched turn does not");
		} finally {
			await close();
		}
	});
});
