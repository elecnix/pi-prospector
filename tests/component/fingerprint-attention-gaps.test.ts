import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tempDb, type TempDb } from "./helpers.js";
import { countsOf, fingerprintOf, ids, sectionOf, seedNode, seedRun, seedSession } from "./fingerprint-seed.js";

/**
 * The attention section: how long the agent waited for a person. Five sessions
 * waited, and one ran with no typed message (zero counts, still measured).
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
	});
	after(() => t.close());

	it("counts typed messages, gaps, sessions that waited, and gaps by length", async () => {
		const section = sectionOf(await fingerprintOf(t.db), "objective", "attention");
		assert.equal(section.status, "ok");
		assert.equal(section.sessionsMeasured, 6);
		assert.equal(section["typedMessages"], 15);
		assert.equal(section["gaps"], 10);
		assert.equal(section["sessionsWaiting"], 5);
		assert.deepEqual(countsOf(section["byWait"], ["wait"]), { "0-10s": 5, "10s-1m": 5 });
	});

	it("publishes other for sessions measured with other bounds, as the schema allows", async () => {
		const u = await tempDb();
		try {
			for (const id of ids("custom", 5)) {
				await seedSession(u.db, id);
				await seedRun(u.db, id, "attention-gaps", "1.0");
				const custom = { ...node([1, 1, 0, 0, 0, 0]), buckets: [{ le_seconds: 5, count: 1 }, { le_seconds: null, count: 1 }] };
				await seedNode(u.db, id, "attention-gaps", custom, "1.0");
			}
			// fingerprintOf checks the result against the composed schema.
			const section = sectionOf(await fingerprintOf(u.db), "objective", "attention");
			assert.deepEqual(countsOf(section["byWait"], ["wait"]), { other: 10 });
		} finally {
			await u.close();
		}
	});

	it("carries no message id", async () => {
		assert.ok(!JSON.stringify(await fingerprintOf(t.db)).includes("hunter2"));
	});
});
