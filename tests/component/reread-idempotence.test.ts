/**
 * The one-time cursor migration re-reads one line that is already stored, and
 * `--reread` re-reads whole files. This file proves the sync is idempotent for that:
 * after a re-read, every table and every derived value for the session equals what
 * a single fresh sync of the same file produces.
 *
 * It also proves the migration's guard on the real database class: it lowers a cursor
 * exactly once across closes and reopens.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { openAsyncDatabase, type AsyncDatabase } from "../../src/db/async-db.js";
import { lowerOldLineCursors, migrate } from "../../src/db/schema.js";
import { runSync } from "../../src/sync/index.js";
import type { SessionSourceAdapter } from "../../src/sync/adapter.js";
import { PiFileSource } from "../../src/sync/sources/pi/index.js";
import { PiSubagentSource } from "../../src/sync/sources/pi-subagent/index.js";
import { ClaudeFileSource } from "../../src/sync/sources/claude/index.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { claudeSessionFileName, makeTempRoot, mockFramework, piSessionFileName, sessionHeaderLine } from "./helpers.js";

const SID = "11111111-2222-4333-a444-555555555555";
const PARENT = "aaaa0001-bbbb-cccc-dddd-eeeeeeeeeeee";

/** Close a database a failed test may have left open; a handle already closed is not an error. */
async function closeQuietly(db: AsyncDatabase | undefined): Promise<void> {
	if (!db) return;
	try {
		await db.close();
	} catch {
		/* already closed */
	}
}

describe("the migration's one-shot guard on the real database class", () => {
	it("lowers a cursor exactly once across three migrations and a close and reopen", async () => {
		const { root, cleanup } = makeTempRoot("prospect-guard-");
		const file = path.join(root, "guard.db");
		let db: AsyncDatabase | undefined;
		try {
			db = openAsyncDatabase(file);
			await migrate(db);
			await db.exec("INSERT INTO sessions (id, file_path, source, last_line) VALUES ('s1', '/x/s1.jsonl', 'claude', 10), ('s2', '/x/s2.jsonl', 'codex', 10)");
			// The database as the old code left it.
			await db.exec("PRAGMA user_version = 0");
			const open = db;
			const cursors = async (): Promise<number[]> => ((await open.prepare("SELECT last_line FROM sessions ORDER BY id").all()) as Array<{ last_line: number }>).map((r) => r.last_line);
			await migrate(db);
			assert.deepEqual(await cursors(), [9, 10], "only the affected sources are lowered");
			await migrate(db);
			await db.close();
			db = openAsyncDatabase(file);
			await migrate(db);
			await migrate(db);
			const reopened = db;
			assert.deepEqual(((await reopened.prepare("SELECT last_line FROM sessions ORDER BY id").all()) as Array<{ last_line: number }>).map((r) => r.last_line), [9, 10], "later migrations leave the cursor alone");
			assert.deepEqual(await db.pragma("user_version"), [{ user_version: 1 }], "the guard reads the shape the real class returns");
		} finally {
			// Closing twice is safe to skip: the handle is closed here whether or not the test failed.
			await closeQuietly(db);
			cleanup();
		}
	});
});

describe("the migration's cursor change and its guard are one transaction", () => {
	it("lowers a cursor once in total when the migration fails after the update", async () => {
		const { root, cleanup } = makeTempRoot("prospect-atomic-");
		let db: AsyncDatabase | undefined;
		try {
			db = openAsyncDatabase(path.join(root, "atomic.db"));
			await migrate(db);
			await db.exec("INSERT INTO sessions (id, file_path, source, last_line) VALUES ('s1', '/x/s1.jsonl', 'claude', 10)");
			await db.exec("PRAGMA user_version = 0");
			const cursor = async (): Promise<number> => ((await db!.prepare("SELECT last_line FROM sessions").get()) as { last_line: number }).last_line;
			// A crash between the update and the version write.
			await assert.rejects(lowerOldLineCursors(db, { afterUpdate: async () => { throw new Error("crash"); } }), /crash/);
			assert.equal(await cursor(), 10, "the update rolled back with the failed migration");
			assert.deepEqual(await db.pragma("user_version"), [{ user_version: 0 }]);
			// The next open runs the migration, and it lowers once in total.
			await migrate(db);
			await migrate(db);
			assert.equal(await cursor(), 9);
			assert.deepEqual(await db.pragma("user_version"), [{ user_version: 1 }]);
		} finally {
			await closeQuietly(db);
			cleanup();
		}
	});
});

/** Every row of every table, in a stable order. */
async function dump(db: AsyncDatabase): Promise<Record<string, unknown[]>> {
	const tables = ((await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) as Array<{ name: string }>).map((t) => t.name);
	const out: Record<string, unknown[]> = {};
	for (const t of tables) {
		try {
			out[t] = await db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all();
		} catch {
			out[t] = await db.prepare(`SELECT * FROM "${t}"`).all();
		}
	}
	return out;
}

/** What the analyzers derive from a session, without the columns that only name the run. */
async function derived(db: AsyncDatabase, session: string): Promise<unknown[]> {
	const fw = mockFramework(db as never);
	await fw.register(turnPairCoreAnalyzer);
	assert.equal((await fw.run(session, {})).errors.length, 0);
	return db.prepare("SELECT analyzer_id, node_kind, input_key, output_key, content_json FROM analysis_nodes WHERE session_id = ? ORDER BY input_key").all(session);
}

interface Case {
	name: string;
	adapter: (root: string) => SessionSourceAdapter;
	file: (root: string) => string;
	lines: (lastIsMessage: boolean) => string[];
}

const claudeLines = (lastIsMessage: boolean): string[] => [
	JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-02-01T09:00:00.000Z", cwd: "/tmp/p", message: { role: "user", content: "go" } }),
	JSON.stringify({ type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "2026-02-01T09:00:01.000Z", message: { id: "m1", role: "assistant", model: "m", stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 }, content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } }),
	JSON.stringify({ type: "user", uuid: "u2", parentUuid: "a1", timestamp: "2026-02-01T09:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] } }),
	lastIsMessage
		? JSON.stringify({ type: "assistant", uuid: "a2", parentUuid: "u2", timestamp: "2026-02-01T09:00:03.000Z", message: { id: "m2", role: "assistant", model: "m", stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 7 }, content: [{ type: "text", text: "done" }] } })
		: JSON.stringify({ type: "ai-title", aiTitle: "A title", sessionId: SID }),
];

const piLines = (lastIsMessage: boolean): string[] => [
	sessionHeaderLine(SID, { timestamp: "2026-08-19T01:02:17Z" }),
	JSON.stringify({ type: "message", id: "p1", timestamp: "2026-08-19T01:03:00Z", message: { role: "user", content: "go" } }),
	JSON.stringify({ type: "message", id: "p2", parentId: "p1", timestamp: "2026-08-19T01:04:00Z", message: { role: "assistant", model: "m", stopReason: "toolUse", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } }, content: [{ type: "text", text: "ok" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] } }),
	JSON.stringify({ type: "message", id: "p3", parentId: "p2", timestamp: "2026-08-19T01:05:00Z", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "a.txt" }] } }),
	lastIsMessage
		? JSON.stringify({ type: "message", id: "p4", parentId: "p3", timestamp: "2026-08-19T01:06:00Z", message: { role: "assistant", model: "m", stopReason: "stop", usage: { input: 20, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 27, cost: { total: 0.5 } }, content: [{ type: "text", text: "done" }] } })
		: JSON.stringify({ type: "session_info", name: "A name", timestamp: "2026-08-19T01:06:00Z" }),
];

const cases: Case[] = [
	{ name: "Claude Code", adapter: (r) => new ClaudeFileSource(r), file: (r) => path.join(r, "-tmp-p", claudeSessionFileName("reread")), lines: claudeLines },
	{ name: "Pi", adapter: (r) => new PiFileSource(r), file: (r) => path.join(r, "--tmp-p--", piSessionFileName(SID)), lines: piLines },
	{ name: "Pi subagent", adapter: (r) => new PiSubagentSource(r), file: (r) => path.join(r, "--tmp-p--", `2026-03-01T09-59-00Z_${PARENT}`, "2b83bd26", "run-0", "session.jsonl"), lines: piLines },
];

/** Databases opened by `syncOnce`, closed by the test's `finally` even when it fails. */
async function syncOnce(root: string, c: Case, lines: string[], opened: AsyncDatabase[]): Promise<{ db: AsyncDatabase; id: string }> {
	const dbFile = path.join(root, `${Math.random().toString(36).slice(2)}.db`);
	const db = openAsyncDatabase(dbFile);
	opened.push(db);
	await migrate(db);
	const sessions = path.join(root, "sessions");
	const target = c.file(sessions);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, lines.join("\n") + "\n");
	// One modification time for every sync of the file, so last_modified compares equal.
	fs.utimesSync(target, 1_800_000_000, 1_800_000_000);
	const result = await runSync(db, [c.adapter(sessions)], {});
	assert.deepEqual(result.errors, []);
	const row = (await db.prepare("SELECT id FROM sessions").get()) as { id: string };
	return { db, id: row.id };
}

describe("re-reading one line that is already stored", () => {
	for (const c of cases) {
		for (const lastIsMessage of [true, false]) {
			it(`${c.name}: leaves every table and derived value as a single fresh sync has them (last line is ${lastIsMessage ? "a message" : "not a message"})`, async () => {
				const { root, cleanup } = makeTempRoot("prospect-reread-");
				const lines = c.lines(lastIsMessage);
				const opened: AsyncDatabase[] = [];
				try {
					const fresh = await syncOnce(root, c, lines, opened);
					const reread = await syncOnce(root, c, lines, opened);
					{
						// The cursor is one past the last line the migration would lower: put it one before the end and sync again.
						const before = ((await reread.db.prepare("SELECT last_line FROM sessions").get()) as { last_line: number }).last_line;
						await reread.db.prepare("UPDATE sessions SET last_line = last_line - 1, last_modified = 0").run();
						const result = await runSync(reread.db, [c.adapter(path.join(root, "sessions"))], {});
						assert.deepEqual(result.errors, []);
						assert.equal(result.sessionsProcessed, 1, "the lowered cursor makes the sync read the file again");
						const after = ((await reread.db.prepare("SELECT last_line FROM sessions").get()) as { last_line: number }).last_line;
						assert.equal(after, before, "the cursor returns to the end of the file");
						assert.equal(after, lines.length, "the cursor is the number of lines in the file");

						assert.deepEqual(await derived(reread.db, reread.id), await derived(fresh.db, fresh.id));
						const a = await dump(fresh.db);
						const b = await dump(reread.db);
						// The analysis tables name the run (ids, creation times); their content is compared through derived().
						for (const t of Object.keys(a)) if (t.startsWith("analy") || t === "prompt_registry") { delete a[t]; delete b[t]; }
						assert.deepEqual(b, a);
						assert.ok((a["messages"] as unknown[]).length >= 3, "the fixture holds messages");
					}
				} finally {
					for (const d of opened) await closeQuietly(d);
					cleanup();
				}
			});
		}
	}
});
