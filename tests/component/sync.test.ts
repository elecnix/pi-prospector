import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { runSync } from "../../src/sync/index.js";
import { getStats } from "../../src/db/queries.js";
import { tempDb } from "./helpers.js";

const FIXTURES = path.resolve(import.meta.dirname, "..", "fixtures");

describe("end-to-end sync", () => {
	it("syncs simple.jsonl into database", () => {
		const { db, close } = tempDb();
		try {
			const result = runSync(db, FIXTURES);
			assert.ok(result.sessionsProcessed >= 1, `expected >=1 session, got ${result.sessionsProcessed}`);
			assert.ok(result.messagesInserted > 0, `expected messages, got ${result.messagesInserted}`);
			const stats = getStats(db);
			assert.ok(stats.totalSessions >= 1);
			assert.ok(stats.totalMessages >= 1);
		} finally {
			close();
		}
	});

	it("incremental re-sync skips unchanged files", () => {
		const { db, close } = tempDb();
		try {
			runSync(db, FIXTURES);
			const stats1 = getStats(db);

			const result2 = runSync(db, FIXTURES);
			assert.ok(result2.sessionsSkipped >= 1);
			assert.equal(result2.messagesInserted, 0);

			const stats2 = getStats(db);
			assert.equal(stats2.totalSessions, stats1.totalSessions);
		} finally {
			close();
		}
	});

	it("handles compacted session (compactionSummary entries)", () => {
		const { db, close } = tempDb();
		try {
			runSync(db, FIXTURES);
			const stats = getStats(db);
			assert.ok(stats.totalSessions >= 2, "should index at least 2 sessions (simple + compacted)");
		} finally {
			close();
		}
	});
});
