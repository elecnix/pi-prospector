import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tempDb, type TempDb } from "./helpers.js";
import { fingerprintOf, leakedSentinels, sectionOf, seedNode, seedRun, seedSession } from "./fingerprint-seed.js";

const pr = (number: number, via = "gh_pr_create") => ({
	session_id: "x",
	pull_request: {
		url: `https://github.com/secret-owner/hunter2/pull/${number}`,
		host: "github.com",
		owner: "secret-owner",
		repo: "hunter2",
		number,
		title: "Secret title",
		via,
		call_message_id: "m1",
		result_message_id: "m2",
	},
});

describe("fingerprint section: pull requests opened", () => {
	let t: TempDb;
	before(async () => {
		t = await tempDb();
		for (let i = 1; i <= 7; i++) {
			const id = `s${i}`;
			await seedSession(t.db, id);
			// s7 ran pr-opened, opened nothing, and is measured as a session without one.
			await seedRun(t.db, id, "pr-opened", "1.1");
			if (i <= 5) await seedNode(t.db, id, "pr-opened", "1.1", pr(i));
		}
		// s1 grew between runs: its first pull request has a second current node, and it opened another.
		await seedNode(t.db, "s1", "pr-opened", "1.1", pr(1), "2026-05-02T00:00:00.000Z");
		await seedNode(t.db, "s1", "pr-opened", "1.1", pr(100, "stacked"), "2026-05-02T00:00:00.000Z");
		// s8 was last run by 1.0, which did not read stacked pull requests: it is not measured.
		await seedSession(t.db, "s8");
		await seedRun(t.db, "s8", "pr-opened", "1.0");
		await seedNode(t.db, "s8", "pr-opened", "1.0", pr(8));
	});
	after(() => t.close());

	it("counts each pull request once per session, from sessions a reading version measured", async () => {
		const fp = await fingerprintOf(t.db);
		const s = sectionOf(fp, "pullRequests");
		assert.equal(s.status, "ok");
		assert.equal(s["sessionsMeasured"], 7);
		assert.equal(s["opened"], 6);
		assert.equal(s["sessionsOpening"], 5);
		// The one stacked pull request rests on one session, so the guard withholds it.
		assert.deepEqual(s["byVia"], [{ via: "gh_pr_create", count: 5, sessions: 5 }]);
		assert.deepEqual(leakedSentinels(fp), []);
	});
});
