/**
 * The cursor a sync stores is the index of the first line not yet read. A session
 * file ends with a newline, so `split("\n")` leaves an empty last element that
 * holds no record. Counting it put the cursor one line past the last record, and
 * the first line appended afterwards landed on the cursor's blind side and was
 * skipped for good. Codex already counted records only; Pi and Claude Code did not.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { openAsyncDatabase } from "../../src/db/async-db.js";
import { migrate } from "../../src/db/schema.js";
import { runSync } from "../../src/sync/index.js";
import type { SessionSourceAdapter } from "../../src/sync/adapter.js";
import { PiFileSource } from "../../src/sync/sources/pi/index.js";
import { ClaudeFileSource } from "../../src/sync/sources/claude/index.js";
import { claudeSessionFileName, makeTempRoot, messageLine, piSessionFileName, sessionHeaderLine } from "./helpers.js";

const SESSION = "11111111-2222-4333-a444-555555555555";

function claudeLine(id: string): string {
	return JSON.stringify({ type: "user", uuid: id, parentUuid: null, timestamp: "2026-02-01T09:00:00.000Z", message: { role: "user", content: id } });
}

async function messageIdsAfterAppend(
	makeAdapter: (root: string) => SessionSourceAdapter,
	file: (root: string) => string,
	first: string[],
	appended: string,
): Promise<string[]> {
	const { root, cleanup } = makeTempRoot("prospect-cursor-");
	const db = openAsyncDatabase(path.join(root, "t.db"));
	try {
		await migrate(db);
		const sessions = path.join(root, "sessions");
		const target = file(sessions);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, first.join("\n") + "\n");
		await runSync(db, [makeAdapter(sessions)], {});
		fs.appendFileSync(target, appended + "\n");
		const later = fs.statSync(target).mtimeMs / 1000 + 5;
		fs.utimesSync(target, later, later);
		const result = await runSync(db, [makeAdapter(sessions)], {});
		assert.deepEqual(result.errors, []);
		return ((await db.prepare("SELECT id FROM messages ORDER BY rowid").all()) as Array<{ id: string }>).map((r) => r.id);
	} finally {
		await db.close();
		cleanup();
	}
}

describe("the line a sync resumes from", () => {
	it("reads the first Claude Code line appended since the last sync", async () => {
		const ids = await messageIdsAfterAppend(
			(root) => new ClaudeFileSource(root),
			(root) => path.join(root, "-tmp-proj", claudeSessionFileName("cursor")),
			[claudeLine("a"), claudeLine("b")],
			claudeLine("c"),
		);
		assert.deepEqual(ids, ["a", "b", "c"]);
	});

	it("reads the first Pi line appended since the last sync", async () => {
		const ids = await messageIdsAfterAppend(
			(root) => new PiFileSource(root),
			(root) => path.join(root, "--tmp-proj--", piSessionFileName(SESSION)),
			[sessionHeaderLine(SESSION), messageLine(SESSION, 1, "user", "one", "2026-08-19T01:03:00Z"), messageLine(SESSION, 2, "assistant", "two", "2026-08-19T01:04:00Z")],
			messageLine(SESSION, 3, "user", "three", "2026-08-19T01:05:00Z"),
		);
		assert.deepEqual(ids, [`${SESSION}-m1`, `${SESSION}-m2`, `${SESSION}-m3`]);
	});
});
