import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tempDb, type TempDb } from "./helpers.js";
import { countsOf, fingerprintOf, ids, sectionOf, seedNode, seedRun, seedSession } from "./fingerprint-seed.js";

/**
 * The assistant-cognition section: confusion, indecision, surprise and apology
 * a model read in the assistant's own words. Six sessions ran a version that
 * looks for apologies; two ran 1.0, which did not, and are not measured.
 */

let t: TempDb;

const judged = (over: Record<string, unknown> = {}) => ({
	user_message_id: "msg-hunter2",
	confusion: [{ level: "mild", rationale: "hunter2" }],
	indecision: [],
	surprise: [{ quote: "hunter2 quote", severity: "high", rationale: "hunter2" }],
	apology: [{ quote: "sorry hunter2", severity: "moderate", rationale: "hunter2" }],
	...over,
});

describe("assistant-cognition fingerprint", () => {
	before(async () => {
		t = await tempDb();
		for (const id of ids("s", 6)) {
			await seedSession(t.db, id);
			await seedRun(t.db, id, "assistant-cognition", "1.1");
			await seedNode(t.db, id, "assistant-cognition", judged(), "1.1");
			await seedNode(t.db, id, "assistant-cognition", judged({ confusion: [{ level: "high", rationale: "x" }], surprise: [], apology: [] }), "1.1");
		}
		for (const id of ids("old", 2)) {
			await seedSession(t.db, id);
			await seedRun(t.db, id, "assistant-cognition", "1.0");
			await seedNode(t.db, id, "assistant-cognition", judged({ apology: undefined }), "1.0");
		}
	});
	after(() => t.close());

	it("counts judged turns and each signal by level", async () => {
		const section = sectionOf(await fingerprintOf(t.db), "inferred", "assistantCognition");
		assert.equal(section.status, "ok");
		assert.equal(section.sessionsMeasured, 6);
		assert.equal(section["turnsJudged"], 12);
		assert.deepEqual(countsOf(section["confusion"], ["confusionLevel"]), { mild: 6, high: 6 });
		assert.deepEqual(section["indecision"], []);
		assert.deepEqual(countsOf(section["surprise"], ["surpriseLevel"]), { high: 6 });
		assert.deepEqual(countsOf(section["apology"], ["apologyLevel"]), { moderate: 6 });
	});

	it("carries no quote and no rationale", async () => {
		assert.ok(!JSON.stringify(await fingerprintOf(t.db)).includes("hunter2"));
	});
});
