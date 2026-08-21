/**
 * The atomicity contract of a per-session sync transaction (issue #59).
 *
 * syncPiSession/syncClaudeSession now commit a session's message inserts, its
 * resume cursor, and its message count as one unit. These tests exercise the
 * property that property exists for: behaviour under a *partial* failure.
 *
 * The sync path is fully defensive — parse errors are swallowed, message inserts
 * are `INSERT OR IGNORE` — so a real session file cannot naturally throw mid-way.
 * To induce a deterministic write failure inside the transaction we arm a
 * `RAISE(ABORT)` trigger on `messages`, gated on a control table. That is a real
 * SQLite write failing mid-transaction, which is what the rollback path must
 * survive; it is the sync-path analog of the write-batching test that emits a
 * structurally invalid edge.
 *
 * Each test is written against this implementation (cursor update inside the
 * same transaction) and has been falsified by temporarily moving `updateCursor`
 * back outside the transaction — the tests go red, proving they exercise the
 * rollback path rather than passing vacuously.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type Database from "better-sqlite3";
import { runSync } from "../../src/sync/index.js";
import { tempDb, NO_CLAUDE_DIR } from "./helpers.js";

/**
 * Arm (when `armed` is true) a trigger that aborts any message insert whose id
 * ends in `-fail`. Placed on `messages` in the temp DB; harmless otherwise.
 */
function armMessageFailure(db: Database.Database, armed: boolean): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS sync_test_armed (id INTEGER PRIMARY KEY);
		CREATE TRIGGER IF NOT EXISTS messages_test_fail AFTER INSERT ON messages
		BEGIN
			SELECT RAISE(ABORT, 'synthetic failure for test')
			WHERE NEW.id LIKE '%-fail'
			  AND (SELECT COUNT(*) FROM sync_test_armed) > 0;
		END;
	`);
	if (armed) db.exec("INSERT OR IGNORE INTO sync_test_armed (id) VALUES (1)");
	else db.exec("DELETE FROM sync_test_armed");
}

interface SessionBuilder {
	piRoot: string;
	/** Project-relative directory under piRoot to place session files in. */
	dir: (name: string) => string;
	cleanup: () => void;
}

function makePiRoot(): SessionBuilder {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "prospect-tx-"));
	const piRoot = path.join(home, ".pi", "agent", "sessions");
	const dir = (name: string) => {
		const d = path.join(piRoot, name);
		fs.mkdirSync(d, { recursive: true });
		return d;
	};
	fs.mkdirSync(dir(""), { recursive: true });
	return { piRoot, dir, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

function piSessionFile(headerId: string, ...messages: Array<Record<string, unknown>>): string[] {
	const lines = [JSON.stringify({ type: "session", version: 3, id: headerId, timestamp: "2026-02-01T09:00:00Z", cwd: "/tmp/proj" })];
	for (const m of messages) lines.push(JSON.stringify(m));
	return lines;
}

describe("per-session sync transaction (issue #59)", () => {
	it("a session that fails mid-sync leaves no partial session", () => {
		const { db, close } = await tempDb();
		const fx = makePiRoot();
		try {
			// Session A succeeds; session B carries a sentinel message that will
			// abort its transaction once the failure trigger is armed.
			const aLines = piSessionFile("sess-a",
				{ type: "message", id: "a-1", timestamp: "2026-02-01T09:01:00Z", message: { role: "user", content: "fine" } },
			);
			fs.writeFileSync(path.join(fx.dir("proj-a"), "sess-a.jsonl"), aLines.join("\n") + "\n");

			const bLines = piSessionFile("sess-b",
				{ type: "message", id: "b-1", timestamp: "2026-02-01T09:01:00Z", message: { role: "user", content: "before the failure" } },
				{ type: "message", id: "b-2-fail", timestamp: "2026-02-01T09:02:00Z", message: { role: "user", content: "boom" } },
			);
			fs.writeFileSync(path.join(fx.dir("proj-b"), "sess-b.jsonl"), bLines.join("\n") + "\n");

			armMessageFailure(db, true);

			const result = runSync(db, fx.piRoot, NO_CLAUDE_DIR);

			assert.ok(result.errors.some((e) => e.includes("sess-b.jsonl")), `error should mention session B, got: ${result.errors}`);
			// Session A is unaffected; only A counts as processed.
			assert.equal(result.sessionsProcessed, 1, "only session A commits; B's failure must not count as processed");
			assert.equal(result.messagesInserted, 1, "only A's message counts as inserted");

			// B must hold ZERO rows — its session row, messages and cursor all
			// rolled back together; nothing partial survives.
			const bSession = db.prepare("SELECT last_line, message_count FROM sessions WHERE id = ?").get("sess-b");
			assert.equal(bSession, undefined, "no session row for B may survive a partial failure");
			const bCount = (db.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ?").get("sess-b") as { c: number }).c;
			assert.equal(bCount, 0, "no message for B may survive a partial failure");

			// A is fully committed.
			const aCount = (db.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ?").get("sess-a") as { c: number }).c;
			assert.equal(aCount, 1);
		} finally {
			fx.cleanup();
await close();
		}
	});

	it("a partial failure does not advance the resume cursor past rolled-back rows", () => {
		const { db, close } = await tempDb();
		const fx = makePiRoot();
		try {
			const filePath = path.join(fx.dir("proj"), "sess.jsonl");

			// The syncer's resume cursor is `lines.length` (the count of
			// `content.split("\n")`). A file ending in a newline yields a trailing
			// empty element, so `last_line` is *one past* the last real line, and an
			// append shifts every later line down by one index. That is a
			// pre-existing cursor miscount (the first appended line is dropped on an
			// incremental re-sync) and is out of scope for issue #59 — it fails the
			// untouched `main` code identically. To keep this test about the
			// transaction, the fixture is written without a trailing newline so that
			// `last_line` points exactly at the first appended line and an append
			// aligns with the resume point.
			const write = (lines: string[], trailingNewline: boolean) =>
				fs.writeFileSync(filePath, lines.join("\n") + (trailingNewline ? "\n" : ""));

			const original = piSessionFile("sess",
				{ type: "message", id: "m1", timestamp: "2026-02-01T09:01:00Z", message: { role: "user", content: "one" } },
			);
			write(original, false);
			const origLineCount = fs.readFileSync(filePath, "utf-8").split("\n").length;

			// Run 1: a clean sync commits the whole session and advances the cursor.
			armMessageFailure(db, false);
			const r1 = runSync(db, fx.piRoot, NO_CLAUDE_DIR);
			assert.equal(r1.errors.length, 0);
			assert.equal((db.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ?").get("sess") as { c: number }).c, 1);
			let cursor = db.prepare("SELECT last_line FROM sessions WHERE id = ?").get("sess") as { last_line: number };
			assert.equal(cursor.last_line, origLineCount, "run 1 advances the cursor to the end of the file");

			// Run 2: append one good row then one failing row. The good row (m2) is
			// inserted inside the transaction, then m3-fail aborts it — so m2 must
			// roll back *with* the failure, and the cursor must NOT advance past
			// either of them.
			const appended = [
				JSON.stringify({ type: "message", id: "m2", timestamp: "2026-02-01T09:02:00Z", message: { role: "assistant", content: "two" } }),
				JSON.stringify({ type: "message", id: "m3-fail", timestamp: "2026-02-01T09:03:00Z", message: { role: "user", content: "boom" } }),
			];
			fs.appendFileSync(filePath, "\n" + appended.join("\n") + "\n");

			armMessageFailure(db, true);
			const r2 = runSync(db, fx.piRoot, NO_CLAUDE_DIR);

			assert.ok(r2.errors.some((e) => e.includes("sess.jsonl")), `second run must report the failure, got: ${r2.errors}`);
			// The already-committed row survives; the appended rows rolled back
			// together — m2 was written, then undone when m3-fail aborted.
			const idsAfter = (await db.prepare("SELECT id FROM messages WHERE session_id = ? ORDER BY id").all("sess")) as Array<{ id: string }>.map((r) => r.id);
			assert.deepEqual(idsAfter, ["m1"], "a successful insert in the session must roll back with the failure");
			cursor = db.prepare("SELECT last_line FROM sessions WHERE id = ?").get("sess") as { last_line: number };
			assert.equal(cursor.last_line, origLineCount, "the cursor must not advance past rows that were rolled back");

			// Run 3: once the failure is gone, sync resumes and imports the rows the
			// failed run rolled back — they are not lost to an advanced cursor.
			armMessageFailure(db, false);
			const r3 = runSync(db, fx.piRoot, NO_CLAUDE_DIR);
			assert.equal(r3.errors.length, 0, `third run should succeed, got: ${r3.errors}`);
			const idsRecovered = (await db.prepare("SELECT id FROM messages WHERE session_id = ? ORDER BY id").all("sess")) as Array<{ id: string }>.map((r) => r.id);
			assert.deepEqual(idsRecovered, ["m1", "m2", "m3-fail"], "re-sync imports the rows the failed run rolled back");
			// The cursor tracks `lines.length` (split length), which includes the
			// trailing empty element after the final newline.
			const finalLineCount = fs.readFileSync(filePath, "utf-8").split("\n").length;
			cursor = db.prepare("SELECT last_line FROM sessions WHERE id = ?").get("sess") as { last_line: number };
			assert.equal(cursor.last_line, finalLineCount, "cursor advances past the full file after a successful re-run");
		} finally {
			fx.cleanup();
await close();
		}
	});
});