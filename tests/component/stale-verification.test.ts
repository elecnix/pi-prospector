/**
 * Component tests for the stale-verification analyzer, exercised end-to-end
 * through the real AnalyzerFramework. No real session data, no network:
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
import { staleVerificationAnalyzer } from "../../src/analyze/analyzers/stale-verification/index.js";

const ANALYZER_ID = "stale-verification";
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

function call(id: string, name: string, args: Record<string, unknown>, s: number): TestMessage {
	return { id: `call-${id}`, role: "assistant", stopReason: "toolUse", timestamp: at(s), toolCalls: [{ id, name, arguments: args }] };
}

function done(id: string, name: string, s: number): TestMessage {
	return {
		id: `res-${id}`,
		role: "toolResult",
		timestamp: at(s),
		toolResults: [{ toolCallId: id, toolName: name, isError: false, textLength: 12 }],
	};
}

/** The agent runs the full suite three times, editing after each pass, then commits. */
function churningSession(): TestMessage[] {
	const msgs: TestMessage[] = [{ role: "user", text: "Fix the date parser.", timestamp: at(0) }];
	for (let i = 0; i < 3; i++) {
		const t = 10 + i * 400;
		msgs.push(call(`v${i}`, "bash", { command: "npm test" }, t), done(`v${i}`, "bash", t + 300));
		msgs.push(call(`e${i}`, "edit", { path: "src/date.ts" }, t + 310), done(`e${i}`, "edit", t + 311));
	}
	msgs.push(call("v3", "bash", { command: "npm test" }, 1300), done("v3", "bash", 1600));
	msgs.push(call("c1", "bash", { command: "git commit -m 'fix: parse dates'" }, 1610), done("c1", "bash", 1611));
	msgs.push({ role: "assistant", text: "Fixed and committed.", timestamp: at(1620) });
	return msgs;
}

/** One passing run, then the commit. */
function cleanSession(): TestMessage[] {
	return [
		{ role: "user", text: "Bump the version.", timestamp: at(0) },
		call("e1", "edit", { path: "package.json" }, 5),
		done("e1", "edit", 6),
		call("v1", "bash", { command: "npm test" }, 10),
		done("v1", "bash", 130),
		call("c1", "bash", { command: "git commit -m 'chore: bump'" }, 140),
		done("c1", "bash", 141),
	];
}

describe("stale-verification component test", () => {
	it("flags runs the agent's own edits made stale, proposes a fix, and anchors run and edit", async () => {
		const { db, close } = await tempDb();
		try {
			const nodes = await runAnalyzerOverSession(db, staleVerificationAnalyzer, "sv-churn", churningSession());
			assert.equal(nodes.length, 1);
			const node = nodes[0]!;
			assert.equal(node.node_kind, "proposal");
			const content = JSON.parse(node.content_json) as Record<string, any>;
			assert.equal(content["passing_run_count"], 4);
			assert.equal(content["stale_runs"].length, 3);
			assert.equal(content["stale_seconds"], 900);
			assert.equal(content["stale_seconds_by_cause"].agent, 900);
			assert.ok(content["stale_runs"].every((s: { outcome: string }) => s.outcome === "rerun"));

			const proposals = (await db
				.prepare("SELECT title FROM proposals WHERE analyzer_id = ?")
				.all(ANALYZER_ID)) as unknown as Array<{ title: string }>;
			assert.equal(proposals.length, 1);
			assert.match(proposals[0]!.title, /3 passing verification runs/);

			const edges = await nodeEdges(db, node.id);
			assert.ok(edges.find((e) => e["edge_kind"] === "anchors" && e["to_ref_kind"] === "session"));
			assert.ok(edges.find((e) => e["to_ref_id"] === "call-v0"), "anchors the stale run");
			assert.ok(edges.find((e) => e["to_ref_id"] === "call-e0"), "anchors the edit that made it stale");
		} finally {
			await close();
		}
	});

	it("a session whose run the commit used gets a metric node and no proposals", async () => {
		const { db, close } = await tempDb();
		try {
			const nodes = await runAnalyzerOverSession(db, staleVerificationAnalyzer, "sv-clean", cleanSession());
			assert.equal(nodes.length, 1);
			assert.equal(nodes[0]!.node_kind, "metric");
			const content = JSON.parse(nodes[0]!.content_json) as Record<string, any>;
			assert.equal(content["passing_run_count"], 1);
			assert.equal(content["stale_runs"].length, 0);
		} finally {
			await close();
		}
	});

	it("an empty transcript plans no unit at all", async () => {
		const { db, close } = await tempDb();
		try {
			assert.equal((await runAnalyzerOverSession(db, staleVerificationAnalyzer, "sv-empty", [])).length, 0);
		} finally {
			await close();
		}
	});

	it("re-running the same recipe is idempotent", async () => {
		const { db, close } = await tempDb();
		try {
			await expectPlainRerunIsNoOpFill(db, staleVerificationAnalyzer, "sv-idem", churningSession());
		} finally {
			await close();
		}
	});

	it("raising the proposal threshold marks the node stale for config and revises it", async () => {
		const { db, close } = await tempDb();
		try {
			const { before, after } = await expectConfigChangeRevises(db, staleVerificationAnalyzer, "sv-config", churningSession(), {
				proposalMinSeconds: 3600,
			});
			assert.equal(before[0]!.node_kind, "proposal");
			const revised = after.find((n) => n.input_key !== before[0]!.input_key)!;
			assert.equal(revised.node_kind, "metric");
			assert.equal((await readAnalyzerNodes(db, ANALYZER_ID)).length, 2, "the old node stays beside the revision");
		} finally {
			await close();
		}
	});
});
