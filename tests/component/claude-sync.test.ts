import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { openAsyncDatabase, type AsyncDatabase } from "../../src/db/async-db.js";
import { migrate } from "../../src/db/schema.js";
import { runSync } from "../../src/sync/index.js";
import { PiFileSource } from "../../src/sync/sources/pi-file.js";
import { ClaudeFileSource } from "../../src/sync/sources/claude-file.js";
import { getStats } from "../../src/db/queries.js";

function adps(piDir: string, claudeDir: string) {
	return [new PiFileSource(piDir), new ClaudeFileSource(claudeDir)];
}

async function tempDb(): Promise<{ db: AsyncDatabase; close: () => Promise<void> }> {
	const dbPath = path.join(os.tmpdir(), `prospect-claude-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
	const db = openAsyncDatabase(dbPath);
	await migrate(db);
	return { db, close: async () => { await db.close(); try { fs.unlinkSync(dbPath); } catch {} } };
}

/**
 * Create a temp directory structure that mimics the real layout:
 *   <tmpRoot>/.pi/agent/sessions/    ← Pi sessions dir (passed to runSync)
 *   <tmpRoot>/.claude/projects/       ← Claude sessions dir (passed to runSync)
 *
 * Returns { piRoot, claudeRoot } — the caller passes both to runSync.
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

describe("Claude session sync", () => {
	it("syncs a Claude session into database", async () => {
		const { db, close } = await tempDb();
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
				const result = await runSync(db, adps(piRoot, claudeRoot));
				assert.ok(result.sessionsProcessed >= 1, `expected >=1 session, got ${result.sessionsProcessed}`);

				// Verify session row
				const session = (await db.prepare("SELECT * FROM sessions WHERE source = 'claude'").get()) as Record<string, unknown>;
				assert.ok(session);
				assert.equal(session.id, "claude-sess-001");
				assert.equal(session.source, "claude");

				// Verify messages: ai-title is not inserted as a message
				const messages = (await db.prepare("SELECT role, source FROM messages WHERE session_id = ? ORDER BY rowid").all("claude-sess-001")) as Array<{ role: string; source: string }>;
				assert.equal(messages.length, 2);
				assert.equal(messages[0]!.role, "user");
				assert.equal(messages[1]!.role, "assistant");
				for (const m of messages) assert.equal(m.source, "claude");

				const stats = await getStats(db);
				assert.equal(stats.claudeSessions, 1);
			} finally {
				cleanupFixture(piRoot);
			}
		} finally {
			await close();
		}
	});

	it("records the serving model on indexed Claude messages, with no cost (issue #65)", async () => {
		const { db, close } = await tempDb();
		try {
			const { piRoot, claudeRoot } = createMixedFixture(
				[],
				[
					{
						projectDir: "-Users-testuser",
						fileName: "claude-cost.jsonl",
						lines: [
							JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-01-15T10:30:00Z", message: { role: "user", content: "Hello" } }),
							JSON.stringify({
								type: "assistant",
								uuid: "a1",
								parentUuid: "u1",
								timestamp: "2026-01-15T10:30:05Z",
								message: {
									role: "assistant",
									model: "claude-opus-5",
									usage: { input_tokens: 100, output_tokens: 50 },
									content: [{ type: "text", text: "Hi there!" }],
								},
							}),
						],
					},
				],
			);
			try {
				await runSync(db, adps(piRoot, claudeRoot));
				const assistant = ((await db
					.prepare("SELECT role, model, cost_usd, usage FROM messages WHERE role = 'assistant'")
					.get()) as { role: string; model: string | null; cost_usd: number | null; usage: string | null });
				assert.equal(assistant.model, "claude-opus-5");
				assert.equal(assistant.cost_usd, null);
				assert.ok(assistant.usage);
				// Claude's token usage is still indexed even though no dollar cost is.
				assert.equal(JSON.parse(assistant.usage!).input, 100);
			} finally {
				cleanupFixture(piRoot);
			}
		} finally {
			await close();
		}
	});

	it("handles incremental re-sync of Claude sessions", async () => {
		const { db, close } = await tempDb();
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
				const r1 = await runSync(db, adps(piRoot, claudeRoot));
				assert.equal(r1.sessionsProcessed, 1);

				const r2 = await runSync(db, adps(piRoot, claudeRoot));
				assert.equal(r1.sessionsProcessed, 1);

				assert.equal(r2.sessionsSkipped, 1);
				assert.equal(r2.messagesInserted, 0);
			} finally {
				cleanupFixture(piRoot);
			}
		} finally {
			await close();
		}
	});

	it("syncs both Pi and Claude sessions together", async () => {
		const { db, close } = await tempDb();
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
				const result = await runSync(db, adps(piRoot, claudeRoot));
				assert.ok(result.sessionsProcessed >= 2, `expected >=2 sessions, got ${result.sessionsProcessed}`);

				const stats = await getStats(db);
				assert.ok(stats.piSessions >= 1);
				assert.ok(stats.claudeSessions >= 1);
			} finally {
				cleanupFixture(piRoot);
			}
		} finally {
			await close();
		}
	});
});
