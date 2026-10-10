/**
 * Component tests for the time-economy analyzer, exercised end-to-end through
 * the real AnalyzerFramework (issue #306). No real session data, no network:
 * hand-written synthetic rows with explicit timestamps. The analyzer never
 * touches the LLM seam.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	tempDb,
	readAnalyzerNodes,
	nodeEdges,
	runAnalyzerOverSession,
	expectPlainRerunIsNoOpFill,
	expectConfigChangeRevises,
	type TestMessage,
} from "./helpers.js";
import { timeEconomyAnalyzer } from "../../src/analyze/analyzers/time-economy/index.js";

const ANALYZER_ID = "time-economy";
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

function call(id: string, command: string, s: number): TestMessage {
	return {
		id: `call-${id}`,
		role: "assistant",
		stopReason: "toolUse",
		timestamp: at(s),
		toolCalls: [{ id, name: "bash", arguments: { command } }],
	};
}

function done(id: string, s: number, text?: string): TestMessage {
	return {
		id: `res-${id}`,
		role: "toolResult",
		timestamp: at(s),
		...(text === undefined ? {} : { text }),
		toolResults: [{ toolCallId: id, toolName: "bash", isError: false, textLength: text?.length ?? 12 }],
	};
}

/** A session that spends 10 minutes in one self-matching wait loop until the harness times it out, then runs the tests. */
function waitingSession(): TestMessage[] {
	return [
		{ role: "user", text: "Start the smoke run and tell me when it finishes.", timestamp: at(0) },
		call("w1", "./smoke.sh > smoke.log 2>&1 &", 5),
		done("w1", 6),
		call("w2", "until ! pgrep -f smoke.sh; do sleep 10; done; tail -5 smoke.log", 10),
		done("w2", 610, "Command did not complete within its 600s timeout and was moved to the background (ID: b1)."),
		call("t1", "npm test", 620),
		done("t1", 680),
		{ role: "assistant", text: "The smoke run finished and the tests pass.", timestamp: at(690) },
	];
}

/** A short session with nothing slow in it. */
function quickSession(): TestMessage[] {
	return [
		{ role: "user", text: "What does the build script do?", timestamp: at(0) },
		call("q1", "cat build.sh", 3),
		done("q1", 4),
		{ role: "assistant", text: "It compiles the sources and copies the assets.", timestamp: at(9) },
	];
}

describe("time-economy component test", () => {
	it("measures a waiting session, proposes fixes, and anchors the waits", async () => {
		const { db, close } = await tempDb();
		try {
			const nodes = await runAnalyzerOverSession(db, timeEconomyAnalyzer, "te-wait", waitingSession());
			assert.equal(nodes.length, 1);
			const node = nodes[0]!;
			assert.equal(node.node_kind, "proposal");
			const content = JSON.parse(node.content_json) as Record<string, any>;
			assert.equal(content["timed_call_count"], 3);
			assert.equal(content["in_call_waits"].seconds, 600);
			assert.equal(content["self_matching_waits"].length, 1);
			assert.equal(content["self_matching_waits"][0].ran_to_limit, true);
			assert.equal(content["timed_out_calls"].call_count, 1);
			assert.equal(content["families"][0].family, "until !");

			const proposals = (await db
				.prepare("SELECT title FROM proposals WHERE analyzer_id = ? ORDER BY title")
				.all(ANALYZER_ID)) as unknown as Array<{ title: string }>;
			assert.equal(proposals.length, 2, "one proposal for waiting, one for the self-matching loop");

			const edges = await nodeEdges(db, node.id);
			assert.ok(edges.find((e) => e["edge_kind"] === "anchors" && e["to_ref_kind"] === "session"));
			assert.ok(
				edges.find((e) => e["edge_kind"] === "anchors" && e["to_ref_id"] === "call-w2"),
				"the finding anchors to the call that waited",
			);
		} finally {
			await close();
		}
	});

	it("a quick session still gets a metric node and no proposals", async () => {
		const { db, close } = await tempDb();
		try {
			const nodes = await runAnalyzerOverSession(db, timeEconomyAnalyzer, "te-quick", quickSession());
			assert.equal(nodes.length, 1, "a clean session is a first-class analysis subject");
			assert.equal(nodes[0]!.node_kind, "metric");
			const count = (await db
				.prepare("SELECT COUNT(*) AS c FROM proposals WHERE analyzer_id = ?")
				.get(ANALYZER_ID)) as unknown as { c: number };
			assert.equal(count.c, 0);
		} finally {
			await close();
		}
	});

	it("an empty transcript plans no unit at all", async () => {
		const { db, close } = await tempDb();
		try {
			const nodes = await runAnalyzerOverSession(db, timeEconomyAnalyzer, "te-empty", []);
			assert.equal(nodes.length, 0);
		} finally {
			await close();
		}
	});

	it("re-running the same recipe is idempotent", async () => {
		const { db, close } = await tempDb();
		try {
			await expectPlainRerunIsNoOpFill(db, timeEconomyAnalyzer, "te-idem", waitingSession());
		} finally {
			await close();
		}
	});

	it("raising the wait threshold marks the node stale for config and revises it", async () => {
		const { db, close } = await tempDb();
		try {
			const { before, after } = await expectConfigChangeRevises(db, timeEconomyAnalyzer, "te-config", waitingSession(), {
				waitProposalMinSeconds: 3600,
				selfMatchProposalMinSeconds: 3600,
			});
			assert.equal(before[0]!.node_kind, "proposal");
			const revised = after.find((n) => n.input_key !== before[0]!.input_key)!;
			assert.equal(revised.node_kind, "metric", "above both thresholds, nothing is proposed");
			assert.equal((await readAnalyzerNodes(db, ANALYZER_ID)).length, 2, "the old node stays beside the revision");
		} finally {
			await close();
		}
	});
});
