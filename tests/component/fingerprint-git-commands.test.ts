import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tempDb, type TempDb } from "./helpers.js";
import { fingerprintOf, leakedSentinels, sectionOf, seedNode, seedRun, seedSession } from "./fingerprint-seed.js";

const node = (commit: [number, number], push: [number, number], merge: [number, number]) => ({
	session_id: "x",
	// Events carry no branch or message today; the sentinels check nothing from them leaks if one ever does.
	events: [{ kind: "commit", succeeded: true, verdict_shared: false, result_checked: true, at: null, call_message_id: "hunter2", result_message_id: "feature/secret-owner" }],
	commit: { attempted: commit[0], succeeded: commit[1] },
	push: { attempted: push[0], succeeded: push[1] },
	pr_merge: { attempted: merge[0], succeeded: merge[1] },
});

describe("fingerprint section: git commands", () => {
	let t: TempDb;
	before(async () => {
		t = await tempDb();
		for (let i = 1; i <= 6; i++) {
			const id = `s${i}`;
			await seedSession(t.db, id);
			await seedRun(t.db, id, "git-commands", "1.0");
			// s6 ran no git command; it is measured with zero.
			await seedNode(t.db, id, "git-commands", i <= 5 ? node([2, 2], [1, 1], [i === 1 ? 1 : 0, i === 1 ? 1 : 0]) : node([0, 0], [0, 0], [0, 0]), "1.0");
		}
		// s7 never ran the analyzer, so its node-less state is not a zero.
		await seedSession(t.db, "s7");
	});
	after(() => t.close());

	it("counts the commands that worked in the measured sessions", async () => {
		const fp = await fingerprintOf(t.db);
		const s = sectionOf(fp, "objective", "gitCommands");
		assert.equal(s.status, "ok");
		assert.equal(s["sessionsMeasured"], 6);
		assert.equal(s["commits"], 10);
		assert.equal(s["pushes"], 5);
		assert.equal(s["sessionsCommitting"], 5);
		assert.equal(s["sessionsPushing"], 5);
		// One session merged: the guard withholds a figure resting on it.
		assert.deepEqual(s["merges"], { status: "withheld", reason: "below-min-group-size" });
		assert.deepEqual(leakedSentinels(fp, ["feature/"]), []);
	});
});
