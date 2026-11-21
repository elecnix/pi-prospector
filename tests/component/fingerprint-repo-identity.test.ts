import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tempDb, type TempDb } from "./helpers.js";
import { fingerprintOf, leakedSentinels, sectionOf, seedNode, seedRun, seedSession } from "./fingerprint-seed.js";

const node = (repo: string | null, basis: string) => ({
	session_id: "x",
	repo_key: repo,
	basis,
	hint_count: repo === null ? 0 : 2,
	candidate_count: 0,
	directory: "hunter2",
	evidence_message_id: null,
});

describe("fingerprint section: repositories", () => {
	let t: TempDb;
	before(async () => {
		t = await tempDb();
		for (let i = 1; i <= 7; i++) {
			const id = `s${i}`;
			await seedSession(t.db, id);
			await seedRun(t.db, id, "repo-identity", "1.0");
		}
		for (let i = 1; i <= 5; i++) await seedNode(t.db, `s${i}`, "repo-identity", "1.0", node("github.com/secret-owner/hunter2", "remote_output"));
		await seedNode(t.db, "s6", "repo-identity", "1.0", node("github.com/secret-owner/other-repo", "pr_url"));
		// s7 had no hint, then grew and gained one: the newer node decides.
		await seedNode(t.db, "s7", "repo-identity", "1.0", node(null, "none"));
		await seedNode(t.db, "s7", "repo-identity", "1.0", node("github.com/secret-owner/third-repo", "gh_repo_flag"), "2026-05-02T00:00:00.000Z");
	});
	after(() => t.close());

	it("counts repositories and the concentration in the busiest one, and never names one", async () => {
		const fp = await fingerprintOf(t.db);
		const s = sectionOf(fp, "repositories");
		assert.equal(s.status, "ok");
		assert.equal(s["sessionsMeasured"], 7);
		assert.equal(s["repositories"], 3);
		assert.equal(s["sessionsInBusiest"], 5);
		assert.deepEqual(s["byBasis"], [{ basis: "remote_output", count: 5, sessions: 5 }]);
		assert.deepEqual(leakedSentinels(fp, ["other-repo", "third-repo"]), []);
	});

	it("withholds the repository count when 1 to 4 sessions have a key", async () => {
		const u = await tempDb();
		try {
			for (let i = 1; i <= 5; i++) {
				await seedSession(u.db, `s${i}`);
				await seedRun(u.db, `s${i}`, "repo-identity", "1.0");
				await seedNode(u.db, `s${i}`, "repo-identity", "1.0", i === 1 ? node("github.com/secret-owner/hunter2", "remote_output") : node(null, "none"));
			}
			const s = sectionOf(await fingerprintOf(u.db), "repositories");
			assert.deepEqual(s["repositories"], { status: "withheld", reason: "below-min-group-size" });
			assert.deepEqual(s["sessionsInBusiest"], { status: "withheld", reason: "below-min-group-size" });
		} finally {
			u.close();
		}
	});
});
