/**
 * Component tests for the delegation-outcomes analyzer, exercised end-to-end
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
import { delegationOutcomesAnalyzer, type DelegationOutcomesProperties } from "../../src/analyze/analyzers/delegation-outcomes/index.js";

function step(id: string, name: string, isError = false): TestMessage[] {
	return [
		{ role: "assistant", stopReason: "toolUse", toolCalls: [{ id, name, arguments: { description: "x" } }] },
		{ role: "toolResult", text: "ok", toolResults: [{ toolCallId: id, toolName: name, isError, textLength: 2 }] },
	];
}

function delegates(): TestMessage[] {
	return [{ role: "user", text: "Split this up." }, ...step("t1", "Task"), ...step("t2", "Task", true), ...step("b1", "bash")];
}

describe("delegation-outcomes component test", () => {
	it("counts outcomes, anchors each call, and states the work that moved to children", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "do-parent");
			const ids = await insertMessages(db, "do-parent", delegates());
			await db.prepare("UPDATE sessions SET message_count = 4 WHERE id = 'do-parent'").run();
			for (const [child, count] of [["do-child-1", 10], ["do-child-2", 5]] as const) {
				await insertSession(db, child);
				await db.prepare("UPDATE sessions SET parent_session = 'do-parent', message_count = ?, source = 'claude' WHERE id = ?").run(count, child);
			}
			// A Pi session naming the parent is a fork, which copies history, so it is not a child.
			await insertSession(db, "do-fork");
			await db.prepare("UPDATE sessions SET parent_session = 'do-parent', message_count = 100, source = 'pi' WHERE id = 'do-fork'").run();
			const fw = mockFramework(db);
			await fw.register(delegationOutcomesAnalyzer);
			const summary = await fw.run("do-parent", {});
			assert.equal(summary.errors.length, 0);

			const nodes = await readAnalyzerNodes(db, "delegation-outcomes");
			assert.equal(nodes.length, 1);
			assert.equal(nodes[0]!.node_kind, "metric");
			const content = JSON.parse(nodes[0]!.content_json) as DelegationOutcomesProperties;
			assert.equal(content.call_count, 2);
			assert.equal(content.counts.completed, 1);
			assert.equal(content.counts.failed, 1);
			assert.equal(content.tool_call_count, 3);
			assert.deepEqual(
				[content.child_session_count, content.child_message_count, content.own_message_count],
				[2, 15, 4],
			);

			const anchors = (await nodeEdges(db, nodes[0]!.id)).filter((e) => e["edge_kind"] === "anchors");
			assert.equal(anchors.filter((e) => e["to_ref_kind"] === "session").length, 1);
			for (const callId of [ids[1], ids[3]]) assert.ok(anchors.find((e) => e["to_ref_id"] === callId));
			const proposals = (await db
				.prepare("SELECT COUNT(*) AS c FROM proposals WHERE analyzer_id = 'delegation-outcomes'")
				.get()) as unknown as { c: number };
			assert.equal(proposals.c, 0);
		} finally {
			await close();
		}
	});

	it("takes the end of a background delegation from the completion record", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "do-bg");
			await insertMessages(db, "do-bg", [{ role: "user", text: "Go." }, ...step("t1", "Task")]);
			await db
				.prepare("INSERT INTO background_tasks (session_id, tool_use_id, task_id, completed_at, status, summary) VALUES (?, ?, NULL, ?, ?, NULL)")
				.run("do-bg", "t1", "2026-10-01T10:00:00.000Z", "killed");
			const fw = mockFramework(db);
			await fw.register(delegationOutcomesAnalyzer);
			await fw.run("do-bg", {});
			const content = JSON.parse((await readAnalyzerNodes(db, "delegation-outcomes"))[0]!.content_json) as DelegationOutcomesProperties;
			assert.equal(content.counts.killed, 1);
			assert.equal(content.events[0]?.background, true);
		} finally {
			await close();
		}
	});

	it("records zero counts for a session that delegated nothing", async () => {
		const { db, close } = await tempDb();
		try {
			const nodes = await runAnalyzerOverSession(db, delegationOutcomesAnalyzer, "do-none", [{ role: "user", text: "Hi." }, ...step("b1", "bash")]);
			const content = JSON.parse(nodes[0]!.content_json) as DelegationOutcomesProperties;
			assert.equal(content.call_count, 0);
			assert.equal(content.child_session_count, 0);
		} finally {
			await close();
		}
	});

	it("plans nothing for an empty transcript", async () => {
		const { db, close } = await tempDb();
		try {
			assert.equal((await runAnalyzerOverSession(db, delegationOutcomesAnalyzer, "do-empty", [])).length, 0);
		} finally {
			await close();
		}
	});

	it("a plain re-run is a no-op fill", async () => {
		const { db, close } = await tempDb();
		try {
			await expectPlainRerunIsNoOpFill(db, delegationOutcomesAnalyzer, "do-rerun", delegates());
		} finally {
			await close();
		}
	});

	it("a config change revises beside the old node", async () => {
		const { db, close } = await tempDb();
		try {
			const { before, after } = await expectConfigChangeRevises(db, delegationOutcomesAnalyzer, "do-cfg", delegates(), {
				delegationToolNames: ["Task", "Spawn"],
			});
			assert.equal(before.length, 1);
			assert.ok(after.length >= 2);
		} finally {
			await close();
		}
	});
});
