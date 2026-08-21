import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runSync } from "../../src/sync/index.js";
import { getStats } from "../../src/db/queries.js";
import { tempDb, NO_CLAUDE_DIR } from "./helpers.js";

const FIXTURES = path.resolve(import.meta.dirname, "..", "fixtures");

describe("end-to-end sync", () => {
	it("syncs simple.jsonl into database", async () => {
		const { db, close } = await tempDb();
		try {
			const result = await runSync(db, FIXTURES, NO_CLAUDE_DIR);
			assert.ok(result.sessionsProcessed >= 1, `expected >=1 session, got ${result.sessionsProcessed}`);
			assert.ok(result.messagesInserted > 0, `expected messages, got ${result.messagesInserted}`);
			const stats = await getStats(db);
			assert.ok(stats.totalSessions >= 1);
			assert.ok(stats.totalMessages >= 1);
		} finally {
			await close();
		}
	});

	it("incremental re-sync skips unchanged files", async () => {
		const { db, close } = await tempDb();
		try {
			await runSync(db, FIXTURES, NO_CLAUDE_DIR);
			const stats1 = await getStats(db);

			const result2 = await runSync(db, FIXTURES, NO_CLAUDE_DIR);
			assert.ok(result2.sessionsSkipped >= 1);
			assert.equal(result2.messagesInserted, 0);

			const stats2 = await getStats(db);
			assert.equal(stats2.totalSessions, stats1.totalSessions);
		} finally {
			await close();
		}
	});

	it("handles compacted session (compactionSummary entries)", async () => {
		const { db, close } = await tempDb();
		try {
			await runSync(db, FIXTURES, NO_CLAUDE_DIR);
			const stats = await getStats(db);
			assert.ok(stats.totalSessions >= 2, "should index at least 2 sessions (simple + compacted)");
		} finally {
			await close();
		}
	});

	it("scopes sync to a single project (avoids full fresh-install scan)", async () => {
		const { db, close } = await tempDb();
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "prospect-scope-sync-"));
		const origUser = process.env.USER;
		process.env.USER = "test";
		try {
			for (const proj of ["projA", "projB"]) {
				const d = path.join(home, `--Users-test--${proj}`);
				fs.mkdirSync(d, { recursive: true });
				fs.writeFileSync(
					path.join(d, `${proj}.jsonl`),
					`{"type":"session","version":3,"id":"${proj}-001","timestamp":"2026-06-01T10:00:00.000Z","cwd":"/home/user/${proj}"}\n` +
						'{"type":"message","id":"m1","message":{"role":"user","content":"hi"}}\n',
				);
			}

			const result = await runSync(db, home, NO_CLAUDE_DIR, { project: "projA" });
			assert.equal(result.sessionsProcessed, 1);
			assert.equal(result.messagesInserted, 1);

			// Only the scoped project's session is indexed — projB is untouched,
			// which is exactly the fresh-install win (skip the other projects).
			const rows = (await db.prepare("SELECT id, project FROM sessions ORDER BY id").all()) as Array<{ id: string; project: string }>;
			assert.deepEqual(rows, [{ id: "projA-001", project: "projA" }]);
		} finally {
			await close();
			process.env.USER = origUser;
			try {
				fs.rmSync(home, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	});

	it("carries model and billed cost through into the message index (issue #65)", async () => {
		const { db, close } = await tempDb();
		try {
			await runSync(db, FIXTURES, NO_CLAUDE_DIR);

			// simple.jsonl's Pi assistant messages record a model and a cost total.
			const assistant = (await db
				.prepare("SELECT model, cost_usd FROM messages WHERE session_id = 'aaaa0001-bbbb-cccc-dddd-eeeeeeeeeeee' AND role = 'assistant' ORDER BY rowid")
				.all()) as Array<{ model: string | null; cost_usd: number | null }>;

			assert.equal(assistant.length, 2);
			assert.equal(assistant[0]!.model, "claude-sonnet-4-5");
			assert.equal(assistant[0]!.cost_usd, 0.003);
			assert.equal(assistant[1]!.model, "claude-sonnet-4-5");
			assert.equal(assistant[1]!.cost_usd, 0.007);

			// Non-assistant rows carry neither field (NULL, never a guessed 0).
			const user = (await db
				.prepare("SELECT model, cost_usd FROM messages WHERE session_id = 'aaaa0001-bbbb-cccc-dddd-eeeeeeeeeeee' AND role = 'user'")
				.get()) as { model: string | null; cost_usd: number | null };
			assert.equal(user.model, null);
			assert.equal(user.cost_usd, null);
		} finally {
			await close();
		}
	});
});
