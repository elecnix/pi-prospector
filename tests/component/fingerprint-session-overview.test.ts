import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tempDb, type TempDb } from "./helpers.js";
import { countsOf, fingerprintOf, ids, sectionOf, seedNode, seedRun, seedSession } from "./fingerprint-seed.js";

/**
 * The session-review section, from session-overview: the friction points a
 * model enumerated, by severity, and the positive signals it tagged. Seven
 * sessions were reviewed. Every free-text field is a sentinel.
 */

let t: TempDb;

const point = (severity: string) => ({ description: "hunter2", what_to_change: "hunter2", evidence: "hunter2", severity });
const review = (points: string[], signals: string[]) => ({
	session_summary: "hunter2 summary",
	friction_points: points.map(point),
	key_positive_signals: signals.map((signal) => ({ description: "hunter2", signal })),
	improvement_proposals: [{ title: "hunter2", target_type: "agents_md", target_path: "/home/secret/AGENTS.md" }],
	stats: { pairs: 4 },
});

describe("session-overview fingerprint", () => {
	before(async () => {
		t = await tempDb();
		for (const id of ids("s", 5)) {
			await seedSession(t.db, id);
			await seedRun(t.db, id, "session-overview", "1.13");
			await seedNode(t.db, id, "session-overview", review(["high", "low"], ["low-tool-failure-density"]), "1.13");
		}
		await seedSession(t.db, "clean");
		await seedRun(t.db, "clean", "session-overview", "1.13");
		await seedNode(t.db, "clean", "session-overview", review([], ["task-completed-without-correction"]), "1.13");
		await seedSession(t.db, "one-point");
		await seedRun(t.db, "one-point", "session-overview", "1.13");
		await seedNode(t.db, "one-point", "session-overview", review(["medium"], ["low-tool-failure-density"]), "1.13");
	});
	after(() => t.close());

	it("counts friction points by severity and positive signals", async () => {
		const section = sectionOf(await fingerprintOf(t.db), "inferred", "sessionReview");
		assert.equal(section.status, "ok");
		assert.equal(section.sessionsMeasured, 7);
		assert.equal(section["frictionPoints"], 11);
		assert.equal(section["sessionsWithFriction"], 6);
		assert.deepEqual(countsOf(section["frictionBySeverity"], ["severity"]), { high: 5, low: 5 });
		assert.deepEqual(countsOf(section["positiveSignals"], ["signal"]), { "low-tool-failure-density": 6 });
	});

	it("carries no summary, evidence, proposal or path", async () => {
		const text = JSON.stringify(await fingerprintOf(t.db));
		for (const s of ["hunter2", "/home/secret", "AGENTS.md"]) assert.ok(!text.includes(s), s);
	});
});
