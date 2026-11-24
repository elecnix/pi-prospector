import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tempDb, type TempDb } from "./helpers.js";
import { countsOf, fingerprintOf, ids, sectionOf, seedNode, seedRun, seedSession } from "./fingerprint-seed.js";

/**
 * The message-origin section: who wrote the messages that start a turn, and
 * what settled each label. Six sessions ran the analyzer; a seventh never did
 * and is not measured.
 */

let t: TempDb;
// Each call is a message of its own: a message has one current node.
let m = 0;
const origin = (o: string, rule: string, decided = true) => ({ user_message_id: `msg-hunter2-${++m}`, pair_index: m, origin: o, rule, decided, suspicions: [] });

describe("message-origin fingerprint", () => {
	before(async () => {
		t = await tempDb();
		for (const id of ids("s", 6)) {
			await seedSession(t.db, id);
			await seedRun(t.db, id, "message-origin", "1.4");
			await seedNode(t.db, id, "message-origin", origin("typed", "no-machine-sign"), "1.4");
			await seedNode(t.db, id, "message-origin", origin("typed", "no-machine-sign"), "1.4");
			await seedNode(t.db, id, "message-origin", origin("pasted", "shell-capture"), "1.4");
			await seedNode(t.db, id, "message-origin", origin("agent", "decision-model"), "1.4");
			await seedNode(t.db, id, "message-origin", origin("typed", "undecided", false), "1.4");
		}
		await seedSession(t.db, "never-ran");
	});
	after(() => t.close());

	it("counts the messages by origin and by what settled the label", async () => {
		const section = sectionOf(await fingerprintOf(t.db), "objective", "messageOrigin");
		assert.equal(section.status, "ok");
		assert.equal(section.sessionsMeasured, 6);
		assert.equal(section["messages"], 30);
		assert.deepEqual(countsOf(section["byOrigin"], ["origin", "settledBy"]), {
			"typed/rule": 12,
			"pasted/rule": 6,
			"agent/model": 6,
			"typed/undecided": 6,
		});
	});

	it("carries no rule name and no message id", async () => {
		const text = JSON.stringify(await fingerprintOf(t.db));
		for (const s of ["no-machine-sign", "shell-capture", "hunter2", "SECRET-PROJECT", "/home/secret"]) assert.ok(!text.includes(s), s);
	});
});
