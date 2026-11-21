import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tempDb, type TempDb } from "./helpers.js";
import { fingerprintOf, leakedSentinels, sectionOf, seedNode, seedRun, seedSession } from "./fingerprint-seed.js";

const verdict = (regression: boolean, causeClass = "config_drift") => ({
	session_id: "x",
	fixes_defect: true,
	is_regression: regression,
	// The cause and the prevention are the model's prose, and the quote is the session's: none may leave.
	cause: "hunter2 cause",
	cause_provenance: regression ? "stated" : "unstated",
	cause_class: regression ? causeClass : "unclassified",
	prevention_class: regression ? "enforce_in_ci" : "unclassified",
	prevention: "hunter2 prevention",
	blamed_pr: 42,
	confidence: 0.7,
	evidence_quote: "Secret title",
	gate_reason: "failure",
	gated: true,
	packet_hash: "abcd",
	packet_sizes: { failures: 1, commits: 1, statements: 1, files: 1 },
});

describe("fingerprint section: regression verdicts", () => {
	let t: TempDb;
	before(async () => {
		t = await tempDb();
		for (let i = 1; i <= 8; i++) {
			const id = `s${i}`;
			await seedSession(t.db, id);
			await seedRun(t.db, id, "regression-verdict", "1.1");
		}
		for (let i = 1; i <= 5; i++) await seedNode(t.db, `s${i}`, "regression-verdict", "1.1", verdict(true));
		// s6 repaired a defect that never worked; s7 and s8 were not admitted by the gate and have no verdict.
		await seedNode(t.db, "s6", "regression-verdict", "1.1", verdict(false));
		// s9 was last judged under the 1.0 taxonomy, whose classes do not compare: it is not measured.
		await seedSession(t.db, "s9");
		await seedRun(t.db, "s9", "regression-verdict", "1.0");
		await seedNode(t.db, "s9", "regression-verdict", "1.0", verdict(true, "assumption_about_input"));
	});
	after(() => t.close());

	it("counts the judged sessions, the regressions among them, and their classes", async () => {
		const fp = await fingerprintOf(t.db);
		const s = sectionOf(fp, "regressions");
		assert.equal(s.status, "ok");
		assert.ok(fp.inferred["regressions"], "a model judged the verdicts, so the section is inferred");
		assert.equal(s["sessionsMeasured"], 8);
		assert.equal(s["judged"], 6);
		assert.equal(s["defectFixes"], 6);
		assert.equal(s["regressions"], 5);
		assert.deepEqual(s["byCauseClass"], [{ causeClass: "config_drift", count: 5, sessions: 5 }]);
		assert.deepEqual(s["byPreventionClass"], [{ preventionClass: "enforce_in_ci", count: 5, sessions: 5 }]);
		assert.deepEqual(s["byProvenance"], [{ provenance: "stated", count: 5, sessions: 5 }]);
		assert.deepEqual(leakedSentinels(fp), []);
	});
});
