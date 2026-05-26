import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/schema.js";
import { runSync } from "../../src/sync/index.js";
import { getStats, insertProposal, listProposals, acceptProposal, rejectProposal } from "../../src/db/queries.js";

const FIXTURES = path.resolve(import.meta.dirname, "..", "fixtures");

function tempDb(): { db: Database.Database; close: () => void } {
	const dbPath = path.join(os.tmpdir(), `prospect-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
	const db = new Database(dbPath);
	migrate(db);
	return { db, close: () => { db.close(); try { fs.unlinkSync(dbPath); } catch {} } };
}

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

			// Second sync should skip all
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
			const result = runSync(db, FIXTURES);
			// compacted.jsonl should be among those synced
			const stats = getStats(db);
			assert.ok(stats.totalSessions >= 2, "should index at least 2 sessions (simple + compacted)");
		} finally {
			close();
		}
	});
});

describe("proposals", () => {
	it("inserts and retrieves a proposal", () => {
		const { db, close } = tempDb();
		try {
			// First insert a session so FK works
			runSync(db, FIXTURES);

			// Get a session ID from the DB
			const row = db.prepare("SELECT id FROM sessions LIMIT 1").get() as { id: string };

			insertProposal(db, {
				id: "p-test-001",
				created_at: new Date().toISOString(),
				session_id: row.id,
				target: "AGENTS.md § Tool usage",
				severity: "friction",
				summary: "Agent reads entire files instead of sections",
				detail: "Details here",
				evidence: "Evidence here",
				status: "new",
				dedup_hash: "test-hash-001",
			});

			const proposals = listProposals(db);
			assert.ok(proposals.length >= 1);
			assert.equal(proposals[0]!.target, "AGENTS.md § Tool usage");
		} finally {
			close();
		}
	});

	it("accepts and rejects proposals", () => {
		const { db, close } = tempDb();
		try {
			runSync(db, FIXTURES);
			const row = db.prepare("SELECT id FROM sessions LIMIT 1").get() as { id: string };

			insertProposal(db, { id: "p1", created_at: new Date().toISOString(), session_id: row.id, target: "t1", severity: "friction", summary: "s1", detail: "", evidence: "", status: "new", dedup_hash: "h1" });
			insertProposal(db, { id: "p2", created_at: new Date().toISOString(), session_id: row.id, target: "t2", severity: "correction", summary: "s2", detail: "", evidence: "", status: "new", dedup_hash: "h2" });

			assert.equal(acceptProposal(db, "p1"), true);
			assert.equal(rejectProposal(db, "p2"), true);

			const accepted = listProposals(db, "accepted");
			assert.equal(accepted.length, 1);
			assert.equal(accepted[0]!.id, "p1");

			const rejected = listProposals(db, "rejected");
			assert.equal(rejected.length, 1);
			assert.equal(rejected[0]!.id, "p2");
		} finally {
			close();
		}
	});

	it("stats include proposal counts", () => {
		const { db, close } = tempDb();
		try {
			runSync(db, FIXTURES);
			const row = db.prepare("SELECT id FROM sessions LIMIT 1").get() as { id: string };

			insertProposal(db, { id: "pa", created_at: new Date().toISOString(), session_id: row.id, target: "a", severity: "friction", summary: "a", detail: "", evidence: "", status: "new", dedup_hash: "ha" });
			insertProposal(db, { id: "pb", created_at: new Date().toISOString(), session_id: row.id, target: "b", severity: "waste", summary: "b", detail: "", evidence: "", status: "accepted", dedup_hash: "hb" });

			const stats = getStats(db);
			assert.equal(stats.proposalsByStatus.new, 1);
			assert.equal(stats.proposalsByStatus.accepted, 1);
		} finally {
			close();
		}
	});
});