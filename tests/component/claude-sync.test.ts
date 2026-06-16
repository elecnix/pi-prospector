import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/schema.js";
import { runSync } from "../../src/sync/index.js";
import { getStats } from "../../src/db/queries.js";

function tempDb(): { db: Database.Database; close: () => void } {
	const dbPath = path.join(os.tmpdir(), `prospect-claude-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
	const db = new Database(dbPath);
	migrate(db);
	return { db, close: () => { db.close(); try { fs.unlinkSync(dbPath); } catch {} } };
}

/**
 * Create a temp directory structure that mimics the real layout:
 *   <tmpRoot>/.pi/agent/sessions/    ← Pi sessions dir (passed to runSync)
 *   <tmpRoot>/.claude/projects/       ← Claude sessions dir (set via PROSPECTOR_CLAUDE_SESSIONS_DIR)
 *
 * Returns { piRoot, claudeRoot } — the caller must set PROSPECTOR_CLAUDE_SESSIONS_DIR.
 */
function createMixedFixture(
	piSessions: Array<{ projectDir: string; fileName: string; lines: string[] }>,
	claudeSessions: Array<{ projectDir: string; fileName: string; lines: string[] }>,
): { piRoot: string; claudeRoot: string } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "prospect-home-"));
	const piRoot = path.join(home, ".pi", "agent", "sessions");
	const claudeRoot = path.join(home, ".claude", "projects");

	// Create Pi session directories and files
	for (const sess of piSessions) {
		const projectDir = path.join(piRoot, sess.projectDir);
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(path.join(projectDir, sess.fileName), sess.lines.join("\n") + "\n");
	}

	// Create Claude directories
	for (const sess of claudeSessions) {
		const projectDir = path.join(claudeRoot, sess.projectDir);
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(path.join(projectDir, sess.fileName), sess.lines.join("\n") + "\n");
	}

	return { piRoot, claudeRoot };
}

function cleanupFixture(piRoot: string): void {
	// piRoot is <tmp>/.pi/agent/sessions, home is 3 levels up
	const home = path.resolve(piRoot, "..", "..", "..");
	fs.rmSync(home, { recursive: true, force: true });
}

/** Set PROSPECTOR_CLAUDE_SESSIONS_DIR and restore it on cleanup. */
function withClaudeDir(claudeRoot: string, fn: () => void): void {
	const prev = process.env.PROSPECTOR_CLAUDE_SESSIONS_DIR;
	try {
		process.env.PROSPECTOR_CLAUDE_SESSIONS_DIR = claudeRoot;
		fn();
	} finally {
		if (prev === undefined) delete process.env.PROSPECTOR_CLAUDE_SESSIONS_DIR;
		else process.env.PROSPECTOR_CLAUDE_SESSIONS_DIR = prev;
	}
}

describe("Claude session sync", () => {
	it("syncs a Claude session into database", () => {
		const { db, close } = tempDb();
		try {
			const { piRoot, claudeRoot } = createMixedFixture(
				[],
				[
					{
						projectDir: "-Users-testuser",
						fileName: "claude-sess-001.jsonl",
						lines: [
							JSON.stringify({ type: "last-prompt", leafUuid: "lp1", sessionId: "claude-sess-001" }),
							JSON.stringify({ type: "ai-title", aiTitle: "Test Claude Session", sessionId: "claude-sess-001" }),
							JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-01-15T10:30:00Z", message: { role: "user", content: "Hello" } }),
							JSON.stringify({ type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "2026-01-15T10:30:05Z", message: { role: "assistant", model: "claude-sonnet", content: [{ type: "text", text: "Hi there!" }] } }),
						],
					},
				],
			);
			try {
				withClaudeDir(claudeRoot, () => {
					const result = runSync(db, piRoot);
					assert.ok(result.sessionsProcessed >= 1, `expected >=1 session, got ${result.sessionsProcessed}`);

					// Verify session row
					const session = db.prepare("SELECT * FROM sessions WHERE source = 'claude'").get() as Record<string, unknown>;
					assert.ok(session);
					assert.equal(session.id, "claude-sess-001");
					assert.equal(session.source, "claude");

					// Verify messages: ai-title is not inserted as a message
					const messages = db.prepare("SELECT role, source FROM messages WHERE session_id = ? ORDER BY rowid").all("claude-sess-001") as Array<{ role: string; source: string }>;
					assert.equal(messages.length, 2);
					assert.equal(messages[0]!.role, "user");
					assert.equal(messages[1]!.role, "assistant");
					for (const m of messages) assert.equal(m.source, "claude");

					const stats = getStats(db);
					assert.equal(stats.claudeSessions, 1);
				});
			} finally {
				cleanupFixture(piRoot);
			}
		} finally {
			close();
		}
	});

	it("handles incremental re-sync of Claude sessions", () => {
		const { db, close } = tempDb();
		try {
			const { piRoot, claudeRoot } = createMixedFixture(
				[],
				[
					{
						projectDir: "-Users-testuser",
						fileName: "claude-incr.jsonl",
						lines: [
							JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-01-15T10:30:00Z", message: { role: "user", content: "test" } }),
						],
					},
				],
			);
			try {
				withClaudeDir(claudeRoot, () => {
					const r1 = runSync(db, piRoot);
					assert.equal(r1.sessionsProcessed, 1);

					const r2 = runSync(db, piRoot);
					assert.equal(r2.sessionsSkipped, 1);
					assert.equal(r2.messagesInserted, 0);
				});
			} finally {
				cleanupFixture(piRoot);
			}
		} finally {
			close();
		}
	});

	it("syncs both Pi and Claude sessions together", () => {
		const { db, close } = tempDb();
		try {
			const { piRoot, claudeRoot } = createMixedFixture(
				[
					{
						projectDir: "--Users-testuser--myproject",
						fileName: "session-pi.jsonl",
						lines: [
							JSON.stringify({ type: "session", version: 3, id: "pi-sess-1", timestamp: "2026-01-15T10:00:00Z", cwd: "/home/user" }),
							JSON.stringify({ type: "message", id: "m1", timestamp: "2026-01-15T10:01:00Z", message: { role: "user", content: "pi message" } }),
						],
					},
				],
				[
					{
						projectDir: "-Users-testuser",
						fileName: "claude-sess.jsonl",
						lines: [
							JSON.stringify({ type: "user", uuid: "cu1", timestamp: "2026-01-15T11:00:00Z", message: { role: "user", content: "claude message" } }),
						],
					},
				],
			);
			try {
				withClaudeDir(claudeRoot, () => {
					const result = runSync(db, piRoot);
					assert.ok(result.sessionsProcessed >= 2, `expected >=2 sessions, got ${result.sessionsProcessed}`);

					const stats = getStats(db);
					assert.ok(stats.piSessions >= 1);
					assert.ok(stats.claudeSessions >= 1);
				});
			} finally {
				cleanupFixture(piRoot);
			}
		} finally {
			close();
		}
	});
});
