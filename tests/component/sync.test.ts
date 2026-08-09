import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runSync } from "../../src/sync/index.js";
import { getStats } from "../../src/db/queries.js";
import { tempDb, NO_CLAUDE_DIR } from "./helpers.js";

const FIXTURES = path.resolve(import.meta.dirname, "..", "fixtures");

/**
 * A real, reachable mid-transaction failure: any message whose content is
 * exactly POISON aborts the INSERT. RAISE(FAIL) is never suppressed by the
 * INSERT OR IGNORE in insertMessage, so it always throws.
 */
function armPoisonTrigger(db: import("better-sqlite3").Database): void {
	db.exec(`
		CREATE TRIGGER poison_message
		BEFORE INSERT ON messages
		WHEN NEW.content_text = 'POISON'
		BEGIN
			SELECT RAISE(FAIL, 'poisoned');
		END;
	`);
}

function makeSessionDir(): { root: string; file: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "prospect-sync-tx-"));
	const proj = path.join(root, "--proj");
	fs.mkdirSync(proj, { recursive: true });
	return { root, file: path.join(proj, "session-tx.jsonl") };
}

const SESSION_HEADER = JSON.stringify({ type: "session", version: 3, id: "tx-sess", timestamp: "2026-01-01T00:00:00Z", cwd: "/x" });
const GOOD_M1 = JSON.stringify({ type: "message", id: "m1", timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "first" } });
const GOOD_M2 = JSON.stringify({ type: "message", id: "m2", timestamp: "2026-01-01T00:00:02Z", message: { role: "user", content: "second" } });
const POISON = JSON.stringify({ type: "message", id: "m3", timestamp: "2026-01-01T00:00:03Z", message: { role: "user", content: "POISON" } });

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
});

describe("a session commits atomically (issue #59)", () => {
	it("a session that fails mid-sync leaves no partial session", () => {
		const { db, close } = tempDb();
		const { root, file } = makeSessionDir();
		try {
			armPoisonTrigger(db);
			// Good message first, then a POISON message that aborts the transaction.
			fs.writeFileSync(file, `${SESSION_HEADER}\n${GOOD_M1}\n${POISON}`);

			const result = runSync(db, root, NO_CLAUDE_DIR);

			// The whole session — including the upsert and the good message — rolled
			// back; nothing partial survives.
			assert.ok(result.errors.length >= 1, "the poisoned file is reported");
			assert.equal(result.sessionsProcessed, 0, "no session commits");
			assert.equal(result.messagesInserted, 0, "no messages commit");
			assert.equal(db.prepare("SELECT count(*) c FROM sessions WHERE id = 'tx-sess'").get()!.c, 0, "no session row");
			assert.equal(db.prepare("SELECT count(*) c FROM messages").get()!.c, 0, "no message rows");
		} finally {
			db.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("a partial failure does not advance the resume cursor past rolled-back rows", () => {
		const { db, close } = tempDb();
		const { root, file } = makeSessionDir();
		try {
			armPoisonTrigger(db);
			fs.writeFileSync(file, `${SESSION_HEADER}\n${GOOD_M1}\n${GOOD_M2}`);

			// First sync commits cleanly. "header\nm1\nm2" splits to 3 elements, so
			// last_line lands on 3 with both messages present.
			const first = runSync(db, root, NO_CLAUDE_DIR);
			assert.equal(first.sessionsProcessed, 1);

			// Append a poisoned line and touch the file so it is re-read. The new line
			// lands at index 3 == the stored resume cursor (previous lines.length).
			fs.appendFileSync(file, `\n${POISON}`);
			const later = new Date().getTime() / 1000 + 10;
			fs.utimesSync(file, later, later);

			const second = runSync(db, root, NO_CLAUDE_DIR);
			assert.ok(second.errors.length >= 1, "the poisoned append is reported");

			const row = db.prepare("SELECT last_line, message_count FROM sessions WHERE id = 'tx-sess'").get()! as { last_line: number; message_count: number };
			assert.equal(row.last_line, 3, "cursor stays at the previously committed line, not the poisoned one");
			assert.equal(row.message_count, 2, "count stays at the committed messages");
			const msgCount = db.prepare("SELECT count(*) c FROM messages WHERE session_id = 'tx-sess'").get()! as { c: number };
			assert.equal(msgCount.c, 2, "no partial message from the failed append");
		} finally {
			db.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
