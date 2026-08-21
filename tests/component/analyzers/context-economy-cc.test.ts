/**
 * Component test for context-economy's compaction-policy judgment (#67).
 * Seeds a session whose context grows and is held across several turns before a
 * late compaction, and asserts the compactionPolicy is recorded and the
 * fired-too-late proposal materialises.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages, type TempDb } from "../helpers.js";
import { AnalyzerFramework } from "../../../src/analyze/framework.js";
import { createMockLLM } from "../../../src/analyze/mock-llm.js";
import { registerAll } from "../../../src/analyze/defaults.js";
import { DEFAULT_MODEL_TIERS } from "../../../src/analyze/model-tiers.js";
import { contextEconomyAnalyzer } from "../../../src/analyze/analyzers/context-economy/index.js";

function setUsage(db: import("better-sqlite3").Database, id: string, u: Record<string, number>): void {
	db.prepare("UPDATE messages SET usage = ? WHERE id = ?").run(JSON.stringify(u), id);
}

describe("context-economy compaction policy", () => {
	it("records a fired-too-late compaction and emits the proposal", async () => {
		const t: TempDb = await tempDb();
		try {
			const sid = "s-cc";
			await insertSession(t.db, sid);
			// user → big read → held across 3 billed turns → late compaction → tail.
			await insertMessages(t.db, sid, [
				{ id: "u0", role: "user", text: "big task" },
				{ id: "a1", role: "assistant", text: "reading", toolCalls: [{ name: "read", arguments: { path: "/big.ts" } }] },
				{ id: "r1", role: "toolResult", toolResults: [{ toolName: "read", isError: false, textLength: 35000 }] }, // 10000 tok
				{ id: "a2", role: "assistant", text: "step 2" },
				{ id: "a3", role: "assistant", text: "step 3" },
				{ id: "a4", role: "assistant", text: "step 4" },
				{ id: "cmp", role: "compaction", text: "[context compacted]" },
				{ id: "a5", role: "assistant", text: "tail" },
			]);
			// usage: growing carried prefix on the 3 held turns; small rebuild after.
			setUsage(t.db, "a1", { input: 100, output: 10, cacheRead: 0, cacheWrite: 500000, totalTokens: 500110 });
			setUsage(t.db, "a2", { input: 100, output: 10, cacheRead: 400000, cacheWrite: 0, totalTokens: 400110 });
			setUsage(t.db, "a3", { input: 100, output: 10, cacheRead: 600000, cacheWrite: 0, totalTokens: 600110 });
			setUsage(t.db, "a4", { input: 100, output: 10, cacheRead: 700000, cacheWrite: 0, totalTokens: 700110 });
			setUsage(t.db, "a5", { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110 });

			// Lower the thresholds so a 3-turn hold of a 10000-token read triggers it.
			const mock = createMockLLM({ responder: () => "{}", tokensPerCall: 0, costPerCall: 0 });
			const fw = new AnalyzerFramework({
				db: t.db,
				llm: mock.caller,
				modelTiers: DEFAULT_MODEL_TIERS,
				configOverrides: { "context-economy": { firedTooLateTurnsMin: 2, firedTooLateCarryTokenTurns: 1000 } },
			});
			const { errors } = await registerAll(fw, { builtins: [contextEconomyAnalyzer] });
			assert.deepEqual(errors, [], JSON.stringify(errors));

			const summary = await fw.run(sid, { analyzerIds: ["context-economy"] });
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			const row = t.db
				.prepare("SELECT content_json, node_kind FROM analysis_nodes WHERE analyzer_id = 'context-economy'")
				.get() as { content_json: string; node_kind: string } | undefined;
			assert.ok(row, "produced a node");
			const c = JSON.parse(row!.content_json);

			// carry avoided = 10000 tok × 3 turns = 30000 token-turns >= 1000; turns spanned 3 >= 2.
			assert.ok(c.compactionPolicy, "compactionPolicy present");
			assert.equal(c.compactionPolicy.compactionCount, 1);
			assert.equal(c.compactionPolicy.firedTooLateCount, 1);
			assert.equal(c.compactionPolicy.cycles[0].firedTooLate, true);
			assert.equal(c.compactionPolicy.cycles[0].turnsSpanned, 4);
			assert.ok(c.compactionPolicy.cycles[0].carryAvoidedTokenTurns >= 30000);

			const late = c.improvement_proposals.find((p: { title: string }) => p.title.includes("Compaction fired too late"));
			assert.ok(late, "fired-too-late proposal present");
			assert.equal(late.target_type, "config");
			assert.ok(late.summary.includes("LOWER BOUND"), "labels carry-avoided as a lower bound");
		} finally {
			t.close();
		}
	});
});
