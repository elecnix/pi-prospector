/**
 * Component tests for the skill-use analyzer, exercised end-to-end through the
 * real AnalyzerFramework. Hand-written synthetic rows, no network.
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
import { skillUseAnalyzer, type SkillUseProperties } from "../../src/analyze/analyzers/skill-use/index.js";

const ANALYZER_ID = "skill-use";

function usesSkills(): TestMessage[] {
	return [
		{ role: "user", text: "Review this change." },
		{
			role: "assistant",
			stopReason: "toolUse",
			toolCalls: [
				{ id: "s1", name: "Skill", arguments: { skill: "review" } },
				{ id: "s2", name: "Skill", arguments: { skill: "deploy" } },
			],
		},
		{
			role: "toolResult",
			text: "loaded",
			toolResults: [
				{ toolCallId: "s1", toolName: "Skill", isError: false, textLength: 6 },
				{ toolCallId: "s2", toolName: "Skill", isError: false, textLength: 6 },
			],
		},
		{ role: "assistant", text: "Done." },
	];
}

function usesNone(): TestMessage[] {
	return [
		{ role: "user", text: "List the files." },
		{ role: "assistant", stopReason: "toolUse", toolCalls: [{ id: "b1", name: "bash", arguments: { command: "ls" } }] },
		{ role: "toolResult", text: "a b", toolResults: [{ toolCallId: "b1", toolName: "bash", isError: false, textLength: 3 }] },
	];
}

describe("skill-use component test", () => {
	it("records each skill and anchors the session and the call row once", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "su-1");
			const ids = await insertMessages(db, "su-1", usesSkills());
			const fw = mockFramework(db);
			await fw.register(skillUseAnalyzer);
			const summary = await fw.run("su-1", {});
			assert.equal(summary.errors.length, 0);
			const nodes = await readAnalyzerNodes(db, ANALYZER_ID);
			assert.equal(nodes.length, 1);
			assert.equal(nodes[0]!.node_kind, "metric");
			const content = JSON.parse(nodes[0]!.content_json) as SkillUseProperties;
			assert.equal(content.skill_call_count, 2);
			assert.equal(content.distinct_skill_count, 2);
			assert.equal(content.tool_call_count, 2);
			assert.deepEqual(content.skills.map((s) => s.name), ["deploy", "review"]);

			const edges = await nodeEdges(db, nodes[0]!.id);
			const anchors = edges.filter((e) => e["edge_kind"] === "anchors");
			assert.equal(anchors.filter((e) => e["to_ref_kind"] === "session").length, 1);
			assert.equal(anchors.filter((e) => e["to_ref_id"] === ids[1]).length, 1, "two skills in one step share one edge");

			const proposals = (await db
				.prepare("SELECT COUNT(*) AS c FROM proposals WHERE analyzer_id = 'skill-use'")
				.get()) as unknown as { c: number };
			assert.equal(proposals.c, 0);
		} finally {
			await close();
		}
	});

	it("records an empty list for a session that loaded no skill", async () => {
		const { db, close } = await tempDb();
		try {
			const nodes = await runAnalyzerOverSession(db, skillUseAnalyzer, "su-none", usesNone());
			assert.equal(nodes.length, 1);
			const content = JSON.parse(nodes[0]!.content_json) as SkillUseProperties;
			assert.deepEqual(content.skills, []);
			assert.equal(content.skill_call_count, 0);
			assert.equal(content.tool_call_count, 1);
		} finally {
			await close();
		}
	});

	it("plans nothing for an empty transcript", async () => {
		const { db, close } = await tempDb();
		try {
			assert.equal((await runAnalyzerOverSession(db, skillUseAnalyzer, "su-empty", [])).length, 0);
		} finally {
			await close();
		}
	});

	it("a plain re-run is a no-op fill", async () => {
		const { db, close } = await tempDb();
		try {
			await expectPlainRerunIsNoOpFill(db, skillUseAnalyzer, "su-rerun", usesSkills());
		} finally {
			await close();
		}
	});

	it("a config change revises beside the old node", async () => {
		const { db, close } = await tempDb();
		try {
			const { before, after } = await expectConfigChangeRevises(db, skillUseAnalyzer, "su-cfg", usesSkills(), {
				skillToolNames: ["Skill", "UseSkill"],
			});
			assert.equal(before.length, 1);
			assert.ok(after.length >= 2);
		} finally {
			await close();
		}
	});
});
