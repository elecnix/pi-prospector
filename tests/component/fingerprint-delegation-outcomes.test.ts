import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tempDb, type TempDb } from "./helpers.js";
import { fingerprintOf, leakedSentinels, sectionOf, seedNode, seedRun, seedSession } from "./fingerprint-seed.js";

const node = (counts: Partial<Record<"completed" | "failed" | "killed" | "revived" | "unanswered" | "other", number>>, children: number, childMessages: number) => {
	const full = { completed: 0, failed: 0, killed: 0, revived: 0, unanswered: 0, other: 0, ...counts };
	return {
		session_id: "x",
		call_count: Object.values(full).reduce((a, b) => a + b, 0),
		counts: full,
		// A custom agent name is the user's own; it must never reach the output.
		events: [{ tool: "hunter2-tool", agent: "secret-owner-agent", outcome: "completed", background: false, call_message_id: "m" }],
		tool_call_count: 10,
		child_session_count: children,
		child_message_count: childMessages,
		own_message_count: 40,
	};
};

describe("fingerprint section: delegation", () => {
	let t: TempDb;
	before(async () => {
		t = await tempDb();
		for (let i = 1; i <= 6; i++) {
			const id = `s${i}`;
			await seedSession(t.db, id);
			await seedRun(t.db, id, "delegation-outcomes", "1.0");
			// s6 delegated nothing.
			await seedNode(t.db, id, "delegation-outcomes", "1.0", i <= 5 ? node({ completed: 2, failed: i === 1 ? 1 : 0 }, 1, 30) : node({}, 0, 0));
		}
	});
	after(() => t.close());

	it("counts delegation calls by outcome and the work moved to children", async () => {
		const fp = await fingerprintOf(t.db);
		const s = sectionOf(fp, "delegation");
		assert.equal(s.status, "ok");
		assert.equal(s["sessionsMeasured"], 6);
		assert.equal(s["calls"], 11);
		assert.equal(s["sessionsDelegating"], 5);
		// One session had a failure: the guard withholds that group.
		assert.deepEqual(s["byOutcome"], [{ outcome: "completed", count: 10, sessions: 5 }]);
		assert.equal(s["childSessions"], 5);
		assert.equal(s["childMessages"], 150);
		assert.equal(s["ownMessages"], 240);
		assert.deepEqual(leakedSentinels(fp, ["-agent", "-tool"]), []);
	});
});
