import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tempDb, type TempDb } from "./helpers.js";
import { fingerprintOf, leakedSentinels, sectionOf, seedNode, seedRun, seedSession } from "./fingerprint-seed.js";

const node = (passing: number, byCause: { agent: number; user: number; subagent: number }, unverifiedCommits: number) => {
	const stale = byCause.agent + byCause.user + byCause.subagent;
	return {
		session_id: "x",
		passing_run_count: 2,
		passing_run_seconds: passing,
		untimed_run_count: 0,
		// A stale run names its command; the command line must never reach the output.
		stale_runs: stale > 0 ? [{ message_id: "m", command: "./hunter2-gate.sh /home/secret/path", seconds: stale, cause: "agent", outcome: "rerun" }] : [],
		stale_seconds: stale,
		stale_seconds_by_cause: byCause,
		timed_out_run_count: 0,
		zero_exit_failures: { count: 0, message_ids: [] },
		unverified_commit_count: unverifiedCommits,
		improvement_proposals: [],
	};
};

describe("fingerprint section: stale verification", () => {
	let t: TempDb;
	before(async () => {
		t = await tempDb();
		for (let i = 1; i <= 6; i++) {
			const id = `s${i}`;
			await seedSession(t.db, id);
			await seedRun(t.db, id, "stale-verification", "1.0");
			// s6 verified and changed nothing after.
			// A run's seconds come from timestamps and need not be whole, as s3's are.
			const agent = i === 3 ? 720.4 : 720;
			await seedNode(t.db, id, "stale-verification", i <= 5 ? node(3600, { agent, user: i === 1 ? 60 : 0, subagent: 0 }, 1) : node(3600, { agent: 0, user: 0, subagent: 0 }, 0), "1.0");
		}
	});
	after(() => t.close());

	it("measures verification time a later edit threw away, by who made the edit", async () => {
		const fp = await fingerprintOf(t.db);
		const s = sectionOf(fp, "objective", "staleVerification");
		assert.equal(s.status, "ok");
		assert.equal(s["sessionsMeasured"], 6);
		assert.equal(s["passingHours"], 6);
		assert.equal(s["staleHours"], 1);
		assert.equal(s["sessionsWithStaleRuns"], 5);
		// The user-caused stale time rests on one session: the guard withholds it.
		assert.deepEqual(s["staleSecondsByCause"], [{ cause: "agent", count: 3600, sessions: 5 }]);
		assert.equal(s["unverifiedCommits"], 5);
		assert.deepEqual(leakedSentinels(fp, ["gate.sh"]), []);
	});
});
