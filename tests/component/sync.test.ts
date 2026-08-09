import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { runSync } from "../../src/sync/index.js";
import { getStats } from "../../src/db/queries.js";
import { tempDb, NO_CLAUDE_DIR } from "./helpers.js";

const FIXTURES = path.resolve(import.meta.dirname, "..", "fixtures");

describe("end-to-end sync", () => {
	it("syncs simple.jsonl into database", () => {
		const { db, close } = tempDb();
		try {
			const result = runSync(db, FIXTURES, NO_CLAUDE_DIR);
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
			runSync(db, FIXTURES, NO_CLAUDE_DIR);
			const stats1 = getStats(db);

			const result2 = runSync(db, FIXTURES, NO_CLAUDE_DIR);
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
			runSync(db, FIXTURES, NO_CLAUDE_DIR);
			const stats = getStats(db);
			assert.ok(stats.totalSessions >= 2, "should index at least 2 sessions (simple + compacted)");
		} finally {
			close();
		}
	});

	it("carries model and billed cost through into the message index (issue #65)", () => {
		const { db, close } = tempDb();
		try {
			runSync(db, FIXTURES, NO_CLAUDE_DIR);

			// simple.jsonl's Pi assistant messages record a model and a cost total.
			const assistant = db
				.prepare("SELECT model, cost_usd FROM messages WHERE session_id = 'aaaa0001-bbbb-cccc-dddd-eeeeeeeeeeee' AND role = 'assistant' ORDER BY rowid")
				.all() as Array<{ model: string | null; cost_usd: number | null }>;

			assert.equal(assistant.length, 2);
			assert.equal(assistant[0]!.model, "claude-sonnet-4-5");
			assert.equal(assistant[0]!.cost_usd, 0.003);
			assert.equal(assistant[1]!.model, "claude-sonnet-4-5");
			assert.equal(assistant[1]!.cost_usd, 0.007);

			// Non-assistant rows carry neither field (NULL, never a guessed 0).
			const user = db
				.prepare("SELECT model, cost_usd FROM messages WHERE session_id = 'aaaa0001-bbbb-cccc-dddd-eeeeeeeeeeee' AND role = 'user'")
				.get() as { model: string | null; cost_usd: number | null };
			assert.equal(user.model, null);
			assert.equal(user.cost_usd, null);
		} finally {
			close();
		}
	});
});
