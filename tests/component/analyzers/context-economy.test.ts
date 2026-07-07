/**
 * Component test for the `context-economy` built-in analyzer.
 * Seeds a session with one big early read (re-billed across later turns), a
 * redundant re-read of the same path, a small late edit, and a Skill invocation —
 * then asserts the analyzer's carry-cost math, flags, skill stats, and proposal
 * output. All expected numbers are hand-computed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages, type TempDb } from "../helpers.js";
import { AnalyzerFramework } from "../../../src/analyze/framework.js";
import { createMockLLM } from "../../../src/analyze/mock-llm.js";
import { registerAll } from "../../../src/analyze/defaults.js";
import { DEFAULT_MODEL_TIERS } from "../../../src/analyze/model-tiers.js";
import { contextEconomyAnalyzer } from "../../../src/analyze/analyzers/context-economy/index.js";

function setUsage(db: import("better-sqlite3").Database, id: string, output: number): void {
	const usage = JSON.stringify({ input: 100, output, cacheRead: 1000, cacheWrite: 0, totalTokens: 1200 });
	db.prepare("UPDATE messages SET usage = ? WHERE id = ?").run(usage, id);
}

describe("context-economy analyzer", () => {
	it("computes carry cost, raises flags, tracks skills, and emits proposals", async () => {
		const t: TempDb = tempDb();
		try {
			const sid = "s1";
			insertSession(t.db, sid);
			// rowid order matters; carry(result) = tokens * billed_assistant_turns_after.
			// charsPerToken 3.5 → 35000 chars = 10000 tokens, 35 chars = 10 tokens, 70 = 20.
			//
			// a1 invokes Skill "pr" — this fires *before* the big read, so
			// skill "pr" sees r1+r2+r3 tokens loaded after its invocation.
			insertMessages(t.db, sid, [
				{ id: "u0", role: "user", text: "do a thing" },
				{
					id: "a1", role: "assistant", text: "invoking skill",
					toolCalls: [
						{ name: "Skill", arguments: { skill: "pr", args: "check the diff" } },
						{ name: "read", arguments: { path: "/big.ts" } },
					],
				},
				{ id: "r1", role: "toolResult", toolResults: [{ toolName: "read", isError: false, textLength: 35000 }] },
				{ id: "a2", role: "assistant", text: "re-reading", toolCalls: [{ name: "read", arguments: { path: "/big.ts" } }] },
				{ id: "r2", role: "toolResult", toolResults: [{ toolName: "read", isError: false, textLength: 35 }] },
				{ id: "a3", role: "assistant", text: "editing", toolCalls: [{ name: "edit", arguments: { path: "/big.ts" } }] },
				{ id: "r3", role: "toolResult", toolResults: [{ toolName: "edit", isError: false, textLength: 70 }] },
			]);
			// three billed assistant turns, output 50 each → 150 total
			for (const id of ["a1", "a2", "a3"]) setUsage(t.db, id, 50);

			const mock = createMockLLM({ responder: () => "{}", tokensPerCall: 0, costPerCall: 0 });
			const fw = new AnalyzerFramework({ db: t.db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			const { errors } = await registerAll(fw, { builtins: [contextEconomyAnalyzer] });
			assert.deepEqual(errors, [], JSON.stringify(errors));

			const summary = await fw.run(sid, { analyzerIds: ["context-economy"] });
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			const row = t.db
				.prepare("SELECT content_json, node_kind FROM analysis_nodes WHERE analyzer_id = 'context-economy'")
				.get() as { content_json: string; node_kind: string } | undefined;
			assert.ok(row, "produced a node");
			assert.equal(row!.node_kind, "proposal", "flags exist → emits proposal node");
			const c = JSON.parse(row!.content_json);

			// ── carry math ──
			// big read = 10000 tok * 2 turns after = 20000; small read = 10 * 1 = 10;
			// edit = 20 * 0 = 0 → read total 20010, edit 0.
			assert.equal(c.turns, 3);
			assert.equal(c.billed.output, 150);
			assert.equal(c.carry.byTool.read, 20010);
			assert.equal(c.carry.byTool.edit, 0);
			assert.equal(c.carry.totalTokenTurns, 20010);
			// readAmplification = (read+bash carry) / output = 20010 / 150 = 133.4 → 133
			assert.equal(c.readAmplification, 133);

			// ── flags ──
			const oversized = c.flags.filter((f: { kind: string }) => f.kind === "oversized-tool-result");
			assert.equal(oversized.length, 1, "one oversized result");
			assert.equal(oversized[0].tokens, 10000);
			assert.equal(oversized[0].tool, "read");

			const redundant = c.flags.filter((f: { kind: string }) => f.kind === "redundant-read");
			assert.equal(redundant.length, 1, "one redundant read path");
			assert.equal(redundant[0].path, "/big.ts");
			assert.equal(redundant[0].count, 2);

			// carry is well below the 1M default → no high-carry flag here
			assert.equal(c.flags.filter((f: { kind: string }) => f.kind === "high-carry-result").length, 0);

			// ── skill stats ──
			assert.ok(Array.isArray(c.skills), "skills array present");
			const prSkill = c.skills.find((s: { skill: string }) => s.skill === "pr");
			assert.ok(prSkill, "skill 'pr' tracked");
			assert.equal(prSkill.invocationCount, 1);
			assert.equal(prSkill.firstOrdinal, 1); // a1 is row 1
			// tokens loaded after a1: r1 (10000) + r2 (10) + r3 (20) = 10030
			assert.equal(prSkill.tokensLoadedAfter, 10030);

			// ── proposals ──
			assert.ok(Array.isArray(c.improvement_proposals), "improvement_proposals present");
			assert.ok(c.improvement_proposals.length >= 2, `expected ≥2 proposals, got ${c.improvement_proposals.length}`);

			// cost-bearing-result proposal (merged from oversized + high-carry at same ordinal)
			const carryProposal = c.improvement_proposals.find(
				(p: { title: string }) => p.title.includes("result at ordinal") || p.title.includes("read result"),
			);
			assert.ok(carryProposal, "carry-related proposal emitted");
			assert.equal(carryProposal.target_type, "prompt");
			assert.equal(carryProposal.severity, "waste");

			// redundant-read proposal
			const redundantProposal = c.improvement_proposals.find(
				(p: { title: string }) => p.title.includes("redundant") || p.title.includes("/big.ts"),
			);
			assert.ok(redundantProposal, "redundant-read proposal emitted");
		} finally {
			t.close();
		}
	});

	it("emits skill-level proposal when tokens-loaded-after exceeds 50k", async () => {
		const t: TempDb = tempDb();
		try {
			const sid = "s2";
			insertSession(t.db, sid);
			// Skill "pr" invoked first, then two enormous reads follow.
			// charsPerToken 3.5 → 200000 chars = ~57142 tokens.
			insertMessages(t.db, sid, [
				{ id: "u0", role: "user", text: "pr skill" },
				{
					id: "a1", role: "assistant", text: "invoking skill",
					toolCalls: [{ name: "Skill", arguments: { skill: "pr" } }],
				},
				{ id: "r1", role: "toolResult", toolResults: [{ toolName: "read", isError: false, textLength: 200000 }] },
				{ id: "a2", role: "assistant", text: "more reading", toolCalls: [{ name: "read", arguments: { path: "/foo.ts" } }] },
				{ id: "r2", role: "toolResult", toolResults: [{ toolName: "read", isError: false, textLength: 100000 }] },
			]);
			for (const id of ["a1", "a2"]) setUsage(t.db, id, 50);

			const mock = createMockLLM({ responder: () => "{}", tokensPerCall: 0, costPerCall: 0 });
			const fw = new AnalyzerFramework({ db: t.db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			const { errors } = await registerAll(fw, { builtins: [contextEconomyAnalyzer] });
			assert.deepEqual(errors, [], JSON.stringify(errors));

			const summary = await fw.run(sid, { analyzerIds: ["context-economy"] });
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			const row = t.db
				.prepare("SELECT content_json FROM analysis_nodes WHERE analyzer_id = 'context-economy'")
				.get() as { content_json: string } | undefined;
			assert.ok(row, "produced a node");
			const c = JSON.parse(row!.content_json);

			const skillProposal = c.improvement_proposals.find(
				(p: { target_type: string }) => p.target_type === "skill",
			);
			assert.ok(skillProposal, "skill proposal emitted when tokens-loaded-after > 50k");
			assert.ok((skillProposal.title as string).includes("pr"), `skill proposal title mentions pr: ${skillProposal.title}`);
		} finally {
			t.close();
		}
	});
});