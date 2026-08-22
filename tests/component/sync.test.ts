import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AsyncDatabase } from "../../src/db/async-db.js";
import { runSync } from "../../src/sync/index.js";
import { PiFileSource } from "../../src/sync/sources/pi-file.js";
import { ClaudeFileSource } from "../../src/sync/sources/claude-file.js";
import { getStats } from "../../src/db/queries.js";
import { tempDb, NO_CLAUDE_DIR } from "./helpers.js";

const FIXTURES = path.resolve(import.meta.dirname, "..", "fixtures");

function adps(piDir: string, claudeDir: string) {
	return [new PiFileSource(piDir), new ClaudeFileSource(claudeDir)];
}

describe("end-to-end sync", () => {
	it("syncs simple.jsonl into database", async () => {
		const { db, close } = await tempDb();
		try {
			const result = await runSync(db, adps(FIXTURES, NO_CLAUDE_DIR));
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
			await runSync(db, adps(FIXTURES, NO_CLAUDE_DIR));
			const stats1 = await getStats(db);

			const result2 = await runSync(db, adps(FIXTURES, NO_CLAUDE_DIR));
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
			await runSync(db, adps(FIXTURES, NO_CLAUDE_DIR));
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

			const result = await runSync(db, [new PiFileSource(home)], { project: "projA" });
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
			await runSync(db, adps(FIXTURES, NO_CLAUDE_DIR));

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
			const user = ((await db
				.prepare("SELECT model, cost_usd FROM messages WHERE session_id = 'aaaa0001-bbbb-cccc-dddd-eeeeeeeeeeee' AND role = 'user'")
				.get()) as { model: string | null; cost_usd: number | null });
			assert.equal(user.model, null);
			assert.equal(user.cost_usd, null);
		} finally {
			await close();
		}
	});

	describe("active tool inventory capture (UNKNOWN vs captured)", () => {
		function writePiFixture(dir: string, sessionFile: string, lines: string[]): void {
			const sessDir = path.join(dir, "--Users-testuser--proj");
			fs.mkdirSync(sessDir, { recursive: true });
			fs.writeFileSync(path.join(sessDir, sessionFile), lines.join("\n") + "\n");
		}

		const header = (extra: string) =>
			JSON.stringify({ type: "session", version: 3, id: "sess-tools", timestamp: "2026-01-15T10:00:00Z", cwd: "/home/user/proj", ...(extra ? JSON.parse(extra) : {}) });

		async function syncOne(db: AsyncDatabase, root: string, lines: string[]): Promise<void> {
			writePiFixture(root, "t.jsonl", lines);
			await runSync(db, [new PiFileSource(root)]);
		}

		async function getInventory(db: AsyncDatabase): Promise<{ tool_inventory: string | null }> {
			const row = (await db.prepare("SELECT tool_inventory FROM sessions WHERE id = 'sess-tools'").get()) as { tool_inventory: string | null };
			assert.ok(row);
			return row;
		}

		it("no manifest -> tool_inventory is NULL (UNKNOWN), never an empty list", async () => {
			const { db, close } = await tempDb();
			try {
				const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppd-tools-"));
				try {
					await syncOne(db, root, [header(""), JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "hi" } })]);
					assert.equal((await getInventory(db)).tool_inventory, null);
				} finally {
					fs.rmSync(root, { recursive: true, force: true });
				}
			} finally {
				await close();
			}
		});

		it("explicit empty manifest -> captured and empty (distinct from UNKNOWN)", async () => {
			const { db, close } = await tempDb();
			try {
				const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppd-tools-"));
				try {
					await syncOne(db, root, [header('{"tools":[]}'), JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "hi" } })]);
					const inv = (await getInventory(db)).tool_inventory;
					assert.ok(inv !== null, "captured-and-empty must not be NULL");
					assert.deepEqual(JSON.parse(inv!), { source: "pi-session-header", tools: [] });
				} finally {
					fs.rmSync(root, { recursive: true, force: true });
				}
			} finally {
				await close();
			}
		});

		it("populated manifest -> inventory with per-tool sizing persisted", async () => {
			const { db, close } = await tempDb();
			try {
				const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppd-tools-"));
				try {
					await syncOne(db, root, [
						header(JSON.stringify({ tools: [{ name: "bash", definitionChars: 512 }, { name: "read", definitionChars: 300 }, { name: "webSearch" }] })),
						JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "hi" } }),
					]);
					const parsed = JSON.parse((await getInventory(db)).tool_inventory!);
					assert.equal(parsed.source, "pi-session-header");
					assert.deepEqual(parsed.tools, [
						{ name: "bash", definitionChars: 512 },
						{ name: "read", definitionChars: 300 },
						{ name: "webSearch", definitionChars: null },
					]);
				} finally {
					fs.rmSync(root, { recursive: true, force: true });
				}
			} finally {
				await close();
			}
		});
	});

	describe("per-bucket cost capture in the message index", () => {
		it("persists the cost breakdown inside the usage JSON for Pi assistant turns", async () => {
			const { db, close } = await tempDb();
			try {
				const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppd-cost-"));
				try {
					const sessDir = path.join(root, "--Users-testuser--proj");
					fs.mkdirSync(sessDir, { recursive: true });
					const lines = [
						JSON.stringify({ type: "session", version: 3, id: "sess-cost", timestamp: "2026-01-15T10:00:00Z", cwd: "/x" }),
						JSON.stringify({
							type: "message",
							id: "m1",
							message: {
								role: "assistant",
								content: [{ type: "text", text: "ok" }],
								usage: { input: 100, output: 50, cacheRead: 900, cacheWrite: 0, totalTokens: 1050, cost: { input: 0.01, output: 0.005, cacheRead: 0.09, cacheWrite: 0, total: 0.105 } },
							},
						}),
					];
					fs.writeFileSync(path.join(sessDir, "c.jsonl"), lines.join("\n") + "\n");
					await runSync(db, [new PiFileSource(root)]);
					const usage = (await db.prepare("SELECT usage FROM messages WHERE session_id = 'sess-cost'").get()) as { usage: string };
					assert.ok(usage);
					const parsed = JSON.parse(usage.usage);
					assert.deepEqual(parsed.cost, { input: 0.01, output: 0.005, cacheRead: 0.09, cacheWrite: 0, total: 0.105 });
				} finally {
					fs.rmSync(root, { recursive: true, force: true });
				}
			} finally {
				await close();
			}
		});
	});

	it("captures the session name from session_info records (issue #207)", async () => {
		const { db, close } = await tempDb();
		try {
			await runSync(db, adps(FIXTURES, NO_CLAUDE_DIR));
			const rows = (await db.prepare("SELECT id, name FROM sessions ORDER BY id").all()) as Array<{ id: string; name: string | null }>;
			const named = rows.find((r) => r.id === "bbbb0002-cccc-dddd-eeee-ffffffffffff");
			assert.ok(named, "named fixture session is indexed");
			assert.equal(named.name, "rusty-dragon-17");
			// A session with no session_info record keeps null — never an empty string.
			const plain = rows.find((r) => r.id === "aaaa0001-bbbb-cccc-dddd-eeeeeeeeeeee");
			assert.ok(plain, "unnamed fixture session is indexed");
			assert.equal(plain.name, null);

			// Idempotent: a re-sync (all files unchanged → skipped) leaves the names alone.
			const result2 = await runSync(db, adps(FIXTURES, NO_CLAUDE_DIR));
			assert.ok(result2.sessionsSkipped >= 1);
		} finally {
			await close();
		}
	});
});
