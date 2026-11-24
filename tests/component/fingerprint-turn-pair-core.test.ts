import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tempDb, type TempDb } from "./helpers.js";
import { countsOf, fingerprintOf, ids, sectionOf, seedNode, seedRun, seedSession } from "./fingerprint-seed.js";

/**
 * The corrections section, from turn-pair-core: how often the person corrected
 * or disputed the agent. Six sessions ran a version that reads message origin;
 * two ran an older one and are not measured, because their corrections include
 * words an agent or the harness wrote. A ninth ran 1.3 last
 * but still carries a turn from 1.2, and is not measured either.
 */

let t: TempDb;
let m = 0;

function pair(over: { correction?: string | null; rebuttal?: boolean; highSignal?: boolean } = {}) {
	const correction = over.correction ?? null;
	return {
		pair_index: 0,
		user_message_id: `msg-${++m}`,
		correction_detected: correction !== null,
		correction_type: correction,
		correction_patterns: correction ? ["hunter2-pattern"] : [],
		correction_text: correction ? "no, hunter2" : null,
		rebuttal_candidate: over.rebuttal ?? false,
		rebuttal_patterns: [],
		rebuttal_text: null,
		tool_call_count: 1,
		deliberation_paragraphs: null,
		tool_failure_count: 0,
		tool_result_bytes: 0,
		tool_waste_bytes: 0,
		empty_response: false,
		friction_score: over.highSignal ? 0.9 : 0.1,
		high_signal: over.highSignal ?? false,
		origin: "typed",
	};
}

describe("turn-pair-core fingerprint", () => {
	before(async () => {
		t = await tempDb();
		for (const id of ids("s", 6)) {
			await seedSession(t.db, id);
			await seedRun(t.db, id, "turn-pair-core", "1.3");
			await seedNode(t.db, id, "turn-pair-core", pair({ correction: "explicit", highSignal: true }), "1.3");
			await seedNode(t.db, id, "turn-pair-core", pair({ correction: "repetition" }), "1.3");
			await seedNode(t.db, id, "turn-pair-core", pair({ rebuttal: true }), "1.3");
		}
		for (const id of ids("old", 2)) {
			await seedSession(t.db, id);
			await seedRun(t.db, id, "turn-pair-core", "1.2");
			await seedNode(t.db, id, "turn-pair-core", pair({ correction: "explicit" }), "1.2");
		}
		// Last run at 1.3 in fill mode, which left the 1.2 node of an older turn current. Its corrections
		// mix both meanings, so it is not measured.
		await seedSession(t.db, "filled");
		await seedRun(t.db, "filled", "turn-pair-core", "1.3");
		await seedNode(t.db, "filled", "turn-pair-core", pair({ correction: "explicit" }), "1.2");
		await seedNode(t.db, "filled", "turn-pair-core", pair(), "1.3");
	});
	after(() => t.close());

	it("counts turns, corrections by type, rebuttal candidates and high-signal turns", async () => {
		const section = sectionOf(await fingerprintOf(t.db), "objective", "corrections");
		assert.equal(section.status, "ok");
		assert.equal(section.sessionsMeasured, 6);
		assert.equal(section["turns"], 18);
		assert.equal(section["corrections"], 12);
		assert.deepEqual(countsOf(section["byCorrectionType"], ["correctionType"]), { explicit: 6, repetition: 6 });
		assert.equal(section["rebuttalCandidates"], 6);
		assert.equal(section["highSignalTurns"], 6);
	});

	it("carries no pattern and no matched text", async () => {
		const text = JSON.stringify(await fingerprintOf(t.db));
		assert.ok(!text.includes("hunter2"));
	});
});
