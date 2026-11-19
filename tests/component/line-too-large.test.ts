/**
 * A single line longer than a string can hold. The streaming reader splits a huge file
 * into lines, but one line past the limit cannot be held either. That file ends as a
 * classified error, counted in the summary: nothing of it is imported, and the other
 * files in the run are unaffected. The limits are lowered so the test stays fast.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { openAsyncDatabase } from "../../src/db/async-db.js";
import { migrate } from "../../src/db/schema.js";
import { runSync } from "../../src/sync/index.js";
import { ClaudeFileSource } from "../../src/sync/sources/claude/index.js";
import { PiFileSource } from "../../src/sync/sources/pi/index.js";
import { SyncFault } from "../../src/sync/faults.js";
import { readSessionLines, setReadLimitsForTests } from "../../src/sync/read-lines.js";
import { claudeSessionFileName, makeTempRoot, messageLine, piSessionFileName, sessionHeaderLine } from "./helpers.js";

const user = (id: string, text: string) => JSON.stringify({ type: "user", uuid: id, parentUuid: null, timestamp: "2026-02-01T09:00:00.000Z", cwd: "/tmp/p", message: { role: "user", content: text } });

describe("a line past the string limit", () => {
	it("is a classified error from the reader, whether it ends the file or not", async () => {
		const { root, cleanup } = makeTempRoot("prospect-long-line-");
		try {
			for (const content of ["ok\n" + "x".repeat(100) + "\nafter\n", "ok\n" + "x".repeat(100), "x".repeat(100)]) {
				const file = path.join(root, "f.jsonl");
				fs.writeFileSync(file, content);
				setReadLimitsForTests({ wholeReadBytes: 0, chunkBytes: 5, maxLineChars: 20 });
				try {
					await assert.rejects(readSessionLines(file), (err: unknown) => err instanceof SyncFault && err.faultClass === "line-too-large");
				} finally {
					setReadLimitsForTests(null);
				}
			}
		} finally {
			cleanup();
		}
	});

	it("leaves the file out of the index, counts it by class, and still imports the others", async () => {
		const { root, cleanup } = makeTempRoot("prospect-long-sync-");
		const db = openAsyncDatabase(path.join(root, "t.db"));
		try {
			await migrate(db);
			const dir = path.join(root, "projects", "-tmp-p");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, claudeSessionFileName("long")), [user("a", "short"), user("b", "y".repeat(200))].join("\n") + "\n");
			fs.writeFileSync(path.join(dir, claudeSessionFileName("fine")), user("c", "ok") + "\n");
			setReadLimitsForTests({ wholeReadBytes: 0, chunkBytes: 16, maxLineChars: 150 });
			let result;
			try {
				result = await runSync(db, [new ClaudeFileSource(path.join(root, "projects"))], {});
			} finally {
				setReadLimitsForTests(null);
			}
			assert.equal(result.errors.length, 1);
			assert.deepEqual(result.bySource["claude"]!.errors, { "line-too-large": 1 });
			assert.equal(result.bySource["claude"]!.visited, 2);
			const ids = ((await db.prepare("SELECT id FROM messages ORDER BY rowid").all()) as Array<{ id: string }>).map((m) => m.id);
			assert.deepEqual(ids, ["c"], "nothing of the long file was imported, not even the short line before it");
			assert.equal(((await db.prepare("SELECT COUNT(*) AS n FROM sessions").get()) as { n: number }).n, 1);
			assert.equal(((await db.prepare("SELECT COUNT(*) AS n FROM message_extras").get()) as { n: number }).n, 1);
		} finally {
			await db.close();
			cleanup();
		}
	});

	it("applies to a Pi file too", async () => {
		const { root, cleanup } = makeTempRoot("prospect-long-pi-");
		const db = openAsyncDatabase(path.join(root, "t.db"));
		try {
			await migrate(db);
			const sid = "11111111-2222-4333-a444-555555555555";
			const file = path.join(root, "sessions", "--tmp-p--", piSessionFileName(sid));
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, [sessionHeaderLine(sid), messageLine(sid, 1, "user", "z".repeat(300), "2026-08-19T01:03:00Z")].join("\n") + "\n");
			setReadLimitsForTests({ wholeReadBytes: 0, chunkBytes: 16, maxLineChars: 200 });
			let result;
			try {
				result = await runSync(db, [new PiFileSource(path.join(root, "sessions"))], {});
			} finally {
				setReadLimitsForTests(null);
			}
			assert.deepEqual(result.bySource["pi"]!.errors, { "line-too-large": 1 });
			assert.equal(((await db.prepare("SELECT COUNT(*) AS n FROM sessions").get()) as { n: number }).n, 0);
		} finally {
			await db.close();
			cleanup();
		}
	});
});
