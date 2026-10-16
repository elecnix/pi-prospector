/**
 * A fork records its parent as a session id, never as the path the header carries.
 *
 * Pi writes `parentSession` in a forked session's header as a path to the parent's
 * file (all 544 of them on a live machine are absolute paths). The column that
 * records the link is `sessions.parent_session`, and every other writer puts a
 * session id there, so storing the header verbatim gave the column two meanings and
 * left every fork unjoinable to its parent (issue #327).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { runSync } from "../../src/sync/index.js";
import { PiFileSource } from "../../src/sync/sources/pi-file.js";
import { makeTempRoot, messageLine, piSessionFileName, sessionHeaderLine, tempDb, writeJsonl } from "./helpers.js";

const PARENT_ID = "019ed12d-96e3-7290-8619-4b7480e9ee44";
const FORK_ID = "019ed135-8262-7e9b-b9b1-ca607d478849";
const PROJECT = "--Users-test--proj";

/** A session line for a fork, whose header names its parent the way pi does. */
function forkHeaderLines(sessionId: string, parentSession: string): string[] {
	return [
		JSON.stringify({
			type: "session",
			version: 3,
			id: sessionId,
			timestamp: "2026-01-15T11:00:00.000Z",
			cwd: "/home/user/proj",
			parentSession,
		}),
		messageLine(sessionId, 1, "user", "continuing from the fork point", "2026-01-15T11:00:05Z"),
	];
}

describe("fork parent identity", () => {
	it("stores the parent's session id, not the path in the header", async () => {
		const { db, close } = await tempDb();
		const fx = makeTempRoot("prospect-fork-");
		try {
			const projectDir = path.join(fx.root, PROJECT);
			const parentFile = piSessionFileName(PARENT_ID, "2026-01-15T10-00-00");
			writeJsonl(projectDir, parentFile, [
				sessionHeaderLine(PARENT_ID, { timestamp: "2026-01-15T10:00:00.000Z" }),
				messageLine(PARENT_ID, 1, "user", "the original conversation", "2026-01-15T10:00:05Z"),
			]);
			writeJsonl(projectDir, piSessionFileName(FORK_ID, "2026-01-15T11-00-00"), forkHeaderLines(FORK_ID, path.join(projectDir, parentFile)));

			const result = await runSync(db, [new PiFileSource(fx.root)]);
			assert.deepEqual(result.errors, []);
			assert.equal(result.forksResolved, 1, "the parent file is there, so the fork resolves");

			const fork = (await db
				.prepare("SELECT parent_session, branch_count FROM sessions WHERE id = ?")
				.get(FORK_ID)) as { parent_session: string | null; branch_count: number };
			assert.equal(fork.parent_session, PARENT_ID, "the link is an id a join can follow");
			assert.equal(fork.branch_count, 1);
		} finally {
			fx.cleanup();
			await close();
		}
	});

	it("falls back to the id in the parent's file name when that file is gone", async () => {
		const { db, close } = await tempDb();
		const fx = makeTempRoot("prospect-fork-");
		try {
			const projectDir = path.join(fx.root, PROJECT);
			const absent = path.join(projectDir, piSessionFileName(PARENT_ID, "2026-01-15T10-00-00"));
			writeJsonl(projectDir, piSessionFileName(FORK_ID, "2026-01-15T11-00-00"), forkHeaderLines(FORK_ID, absent));

			const result = await runSync(db, [new PiFileSource(fx.root)]);
			assert.deepEqual(result.errors, []);
			assert.equal(result.forksResolved, 0, "a parent that is not on disk is not a resolved fork");

			const fork = (await db.prepare("SELECT parent_session FROM sessions WHERE id = ?").get(FORK_ID)) as {
				parent_session: string | null;
			};
			// Pi names a session file after the session, so the name still carries the id.
			assert.equal(fork.parent_session, PARENT_ID);
		} finally {
			fx.cleanup();
			await close();
		}
	});

	it("stores nothing when the parent it names is not a pi session file", async () => {
		const { db, close } = await tempDb();
		const fx = makeTempRoot("prospect-fork-");
		try {
			const projectDir = path.join(fx.root, PROJECT);
			writeJsonl(projectDir, piSessionFileName(FORK_ID, "2026-01-15T11-00-00"), forkHeaderLines(FORK_ID, path.join(projectDir, "notes.jsonl")));

			await runSync(db, [new PiFileSource(fx.root)]);

			const fork = (await db.prepare("SELECT parent_session FROM sessions WHERE id = ?").get(FORK_ID)) as {
				parent_session: string | null;
			};
			assert.equal(fork.parent_session, null, "a name that holds no session id leaves the column empty");
		} finally {
			fx.cleanup();
			await close();
		}
	});
});
