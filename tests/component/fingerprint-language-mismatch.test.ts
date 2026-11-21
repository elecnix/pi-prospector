import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tempDb, type TempDb } from "./helpers.js";
import { countsOf, fingerprintOf, ids, sectionOf, seedNode, seedRun, seedSession } from "./fingerprint-seed.js";

/**
 * The language-mismatch section: replies and compaction summaries written in a
 * different script than the person wrote in. Six sessions had judgable text;
 * one ran with nothing judgable (no node) and is not measured.
 */

let t: TempDb;

const turn = (user: string, assistant: string) => ({ pair_index: 0, user_message_id: "msg-hunter2", user_script: user, assistant_script: assistant, mismatched: user !== assistant });

function node(turns: ReturnType<typeof turn>[], mismatchedCompactions = 0) {
	return {
		session_id: "hunter2",
		turns,
		compactions: [],
		judged_turn_count: turns.length,
		mismatched_turn_count: turns.filter((x) => x.mismatched).length,
		compaction_checked_count: 1,
		mismatched_compaction_count: mismatchedCompactions,
		improvement_proposals: [{ target_type: "agents_md", title: "hunter2", summary: "", detail: "", evidence: "", confidence: 0.6, severity: "friction" }],
	};
}

describe("language-mismatch fingerprint", () => {
	before(async () => {
		t = await tempDb();
		for (const id of ids("s", 6)) {
			await seedSession(t.db, id);
			await seedRun(t.db, id, "language-mismatch", "1.0");
			await seedNode(t.db, id, "language-mismatch", node([turn("cyrillic", "latin"), turn("latin", "latin"), turn("latin", "latin")], 1), "1.0");
		}
		await seedSession(t.db, "nothing-judgable");
		await seedRun(t.db, "nothing-judgable", "language-mismatch", "1.0");
		await seedSession(t.db, "greek");
		await seedRun(t.db, "greek", "language-mismatch", "1.0");
		await seedNode(t.db, "greek", "language-mismatch", node([turn("greek", "latin"), turn("latin", "latin")]), "1.0");
	});
	after(() => t.close());

	it("counts judged and mismatched turns and summaries, and the scripts of each mismatch", async () => {
		const section = sectionOf(await fingerprintOf(t.db), "objective", "languageMismatch");
		assert.equal(section.status, "ok");
		assert.equal(section.sessionsMeasured, 7);
		assert.equal(section["judgedTurns"], 20);
		assert.equal(section["mismatchedTurns"], 7);
		assert.equal(section["summariesChecked"], 7);
		assert.equal(section["mismatchedSummaries"], 6);
		// The one greek → latin session is under the minimum and folds away.
		assert.deepEqual(countsOf(section["byScripts"], ["userScript", "replyScript"]), { "cyrillic/latin": 6 });
	});

	it("carries no proposal text", async () => {
		assert.ok(!JSON.stringify(await fingerprintOf(t.db)).includes("hunter2"));
	});
});
