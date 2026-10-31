/**
 * Component tests for the session-delivery analyzer, exercised end-to-end
 * through the real AnalyzerFramework. Hand-written synthetic rows, no network.
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
	runAnalyzerOverSession,
	expectPlainRerunIsNoOpFill,
	expectConfigChangeRevises,
	type TestMessage,
} from "./helpers.js";
import { sessionDeliveryAnalyzer, type SessionDeliveryProperties } from "../../src/analyze/analyzers/session-delivery/index.js";

function step(id: string, command: string, text: string): TestMessage[] {
	return [
		{ role: "assistant", stopReason: "toolUse", toolCalls: [{ id, name: "bash", arguments: { command } }] },
		{ role: "toolResult", text, toolResults: [{ toolCallId: id, toolName: "bash", isError: false, textLength: text.length }] },
	];
}

function delivers(): TestMessage[] {
	return [
		{ role: "user", text: "Commit and push this." },
		...step("c1", `git commit -m "x"`, "[feat abc1234] x\n 1 file changed"),
		...step("c2", "git commit -m again", "nothing to commit, working tree clean"),
		...step("p1", "git push -u origin feat", "branch feat set up to track origin/feat"),
		{ role: "assistant", text: "Pushed." },
	];
}

describe("session-delivery component test", () => {
	it("counts attempted and succeeded events and anchors each call", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "sd-1");
			const ids = await insertMessages(db, "sd-1", delivers());
			const fw = mockFramework(db);
			await fw.register(sessionDeliveryAnalyzer);
			const summary = await fw.run("sd-1", {});
			assert.equal(summary.errors.length, 0);
			const nodes = await readAnalyzerNodes(db, "session-delivery");
			assert.equal(nodes.length, 1);
			assert.equal(nodes[0]!.node_kind, "metric");
			const content = JSON.parse(nodes[0]!.content_json) as SessionDeliveryProperties;
			assert.deepEqual(content.commit, { attempted: 2, succeeded: 1 });
			assert.deepEqual(content.push, { attempted: 1, succeeded: 1 });
			assert.deepEqual(content.pr_merge, { attempted: 0, succeeded: 0 });
			assert.equal(content.delivered, true);

			const anchors = (await nodeEdges(db, nodes[0]!.id)).filter((e) => e["edge_kind"] === "anchors");
			assert.equal(anchors.filter((e) => e["to_ref_kind"] === "session").length, 1);
			for (const callId of [ids[1], ids[3], ids[5]]) {
				assert.ok(anchors.find((e) => e["to_ref_id"] === callId), "each call is anchored");
			}
			const proposals = (await db
				.prepare("SELECT COUNT(*) AS c FROM proposals WHERE analyzer_id = 'session-delivery'")
				.get()) as unknown as { c: number };
			assert.equal(proposals.c, 0);
		} finally {
			await close();
		}
	});

	it("records an empty list for a session that delivered nothing", async () => {
		const { db, close } = await tempDb();
		try {
			const nodes = await runAnalyzerOverSession(db, sessionDeliveryAnalyzer, "sd-none", [
				{ role: "user", text: "List files." },
				...step("b1", "ls", "a b"),
			]);
			assert.equal(nodes.length, 1);
			const content = JSON.parse(nodes[0]!.content_json) as SessionDeliveryProperties;
			assert.deepEqual(content.events, []);
			assert.equal(content.delivered, false);
		} finally {
			await close();
		}
	});

	it("plans nothing for an empty transcript", async () => {
		const { db, close } = await tempDb();
		try {
			assert.equal((await runAnalyzerOverSession(db, sessionDeliveryAnalyzer, "sd-empty", [])).length, 0);
		} finally {
			await close();
		}
	});

	it("a plain re-run is a no-op fill", async () => {
		const { db, close } = await tempDb();
		try {
			await expectPlainRerunIsNoOpFill(db, sessionDeliveryAnalyzer, "sd-rerun", delivers());
		} finally {
			await close();
		}
	});

	it("a config change revises beside the old node", async () => {
		const { db, close } = await tempDb();
		try {
			const { before, after } = await expectConfigChangeRevises(db, sessionDeliveryAnalyzer, "sd-cfg", delivers(), {
				shellToolNames: ["bash", "shell"],
			});
			assert.equal(before.length, 1);
			assert.ok(after.length >= 2);
		} finally {
			await close();
		}
	});
});
