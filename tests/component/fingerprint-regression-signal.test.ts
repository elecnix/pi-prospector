import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tempDb, type TempDb } from "./helpers.js";
import { fingerprintOf, leakedSentinels, sectionOf, seedNode, seedRun, seedSession } from "./fingerprint-seed.js";

const claim = (claims: boolean, named: boolean, reverts = false) => ({
	session_id: "x",
	claims_regression: claims,
	signals_fired: ["changed_something", "causal_claim"],
	signals: { changed_something: true, reverts, causal_claim: true, names_the_cause: named, sought_the_cause: false, states_it_worked_before: false },
	// Citations name a repository and quote the session: neither may leave.
	cited_pull_requests: [{ host: "github.com", owner: "secret-owner", repo: "hunter2", number: 42, quote: "Secret title", message_id: "m" }],
	cited_commits: [],
	blames_upstream: false,
	never_worked: false,
	evidence_message_ids: ["m"],
});

describe("fingerprint section: regression claims", () => {
	let t: TempDb;
	before(async () => {
		t = await tempDb();
		for (let i = 1; i <= 7; i++) {
			const id = `s${i}`;
			await seedSession(t.db, id);
			await seedRun(t.db, id, "regression-signal", "1.1");
		}
		for (let i = 1; i <= 5; i++) await seedNode(t.db, `s${i}`, "regression-signal", claim(true, true, i === 1), "1.1");
		// s6's claim fell away when the transcript gained text marking it upstream; s7 claimed nothing.
		await seedNode(t.db, "s6", "regression-signal", claim(false, true), "1.1");
		// s8 was last read by 1.0, which required a named cause to claim: it is not measured.
		await seedSession(t.db, "s8");
		await seedRun(t.db, "s8", "regression-signal", "1.0");
		await seedNode(t.db, "s8", "regression-signal", claim(true, true), "1.0");
	});
	after(() => t.close());

	it("counts the sessions that state they repaired a regression, from a version that does not require a named cause", async () => {
		const fp = await fingerprintOf(t.db);
		const s = sectionOf(fp, "objective", "regressionClaims");
		assert.equal(s.status, "ok");
		assert.equal(s["sessionsMeasured"], 7);
		assert.equal(s["claims"], 5);
		assert.equal(s["namedCause"], 5);
		assert.deepEqual(s["reverts"], { status: "withheld", reason: "below-min-group-size" });
		assert.deepEqual(leakedSentinels(fp), []);
	});
});
