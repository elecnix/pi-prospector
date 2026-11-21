import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tempDb, type TempDb } from "./helpers.js";
import { countsOf, fingerprintOf, ids, sectionOf, seedNode, seedRun, seedSession } from "./fingerprint-seed.js";

/**
 * The attention section: how long the agent waited for a person. Five sessions
 * waited, one ran with no typed message (zero counts, still measured), and one
 * has two current nodes.
 */

let t: TempDb;
const BOUNDS = [10, 60, 300, 1800, 7200, null];

function node(counts: number[], typed = 3) {
	return {
		session_id: "hunter2",
		typed_message_count: typed,
		undecided_message_count: 0,
		gap_count: counts.reduce((a, b) => a + b, 0),
		unmeasured_typed_count: typed > 0 ? 1 : 0,
		undecided_gap_count: 0,
		sum_seconds: 600,
		median_seconds: typed > 0 ? 30 : null,
		p90_seconds: null,
		max_seconds: null,
		buckets: BOUNDS.map((le, i) => ({ le_seconds: le, count: counts[i] ?? 0 })),
		longest: [{ user_message_id: "msg-hunter2", seconds: 600 }],
	};
}

describe("attention-gaps fingerprint", () => {
	before(async () => {
		t = await tempDb();
		for (const id of ids("s", 5)) {
			await seedSession(t.db, id);
			await seedRun(t.db, id, "attention-gaps", "1.0");
			await seedNode(t.db, id, "attention-gaps", node([1, 1, 0, 0, 0, 0]), "1.0");
		}
		await seedSession(t.db, "alone");
		await seedRun(t.db, "alone", "attention-gaps", "1.0");
		await seedNode(t.db, "alone", "attention-gaps", node([0, 0, 0, 0, 0, 0], 0), "1.0");
		// Two current nodes, as a re-run on a grown session leaves them until the graph marks the older
		// one revised. Both are read, and their buckets keep their labels.
		await seedSession(t.db, "twice");
		await seedRun(t.db, "twice", "attention-gaps", "1.0");
		await seedNode(t.db, "twice", "attention-gaps", node([1, 1, 0, 0, 0, 0]), "1.0");
		await seedNode(t.db, "twice", "attention-gaps", node([1, 1, 0, 0, 0, 0]), "1.0");
	});
	after(() => t.close());

	it("counts typed messages, gaps, sessions that waited, and gaps by length", async () => {
		const section = sectionOf(await fingerprintOf(t.db), "objective", "attention");
		assert.equal(section.status, "ok");
		assert.equal(section.sessionsMeasured, 7);
		assert.equal(section["typedMessages"], 21);
		assert.equal(section["gaps"], 14);
		assert.equal(section["sessionsWaiting"], 6);
		assert.deepEqual(countsOf(section["byWait"], ["wait"]), { "0-10s": 7, "10s-1m": 7 });
	});

	it("carries no message id", async () => {
		assert.ok(!JSON.stringify(await fingerprintOf(t.db)).includes("hunter2"));
	});
});
