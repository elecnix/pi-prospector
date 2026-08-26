/**
 * Nested async-subagent session ingest (#157).
 *
 * The shared walker now recurses into <project>/<ts>_<uuid>/<runhash>/run-N/
 * so the default PiFileSource discovers child-run session.jsonl files that
 * used to be invisible to prospect. These tests exercise discovery through
 * the real sync loop against hand-written synthetic fixture trees in temp
 * dirs — never real session data:
 *
 *   - a nested run tree syncs each child with its OWN header id and its own
 *     distinct messages (never merged into the parent);
 *   - re-syncing inserts nothing new (cursor contract);
 *   - when the opt-in "pi-subagent" adapter is also present, one sync claims
 *     each file exactly once — no double insertion under two source tags —
 *     and ordering lets the richer adapter win the claim;
 *   - the depth bound holds at sync time: a too-deep tree contributes nothing
 *     and cannot hang the walk.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { runSync } from "../../src/sync/index.js";
import { PiFileSource } from "../../src/sync/sources/pi-file.js";
import { PiSubagentSource } from "../../src/sync/sources/pi-subagent.js";
import { makeTempRoot, messageLine, sessionHeaderLine, tempDb, writeJsonl } from "./helpers.js";

const PARENT_ID = "aaaa1111-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/** Synthetic JSONL for one session: header + two messages unique to it. */
function writeSession(dir: string, sessionId: string): void {
	writeJsonl(dir, sessionId === PARENT_ID ? "parent.jsonl" : "session.jsonl", [
		sessionHeaderLine(sessionId),
		messageLine(sessionId, 1, "user", `hello from ${sessionId}`, "2026-08-19T01:02:20Z"),
		messageLine(sessionId, 2, "assistant", `done (${sessionId})`, "2026-08-19T01:02:25Z"),
	]);
}

/** <root>/--Users-test--proj/<parent>/parent.jsonl and <runhash>/run-N/session.jsonl */
function writeNestedTree(root: string, runHashes: string[]): void {
	writeSession(path.join(root, "--Users-test--proj", PARENT_ID), PARENT_ID);
	for (const [i, runHash] of runHashes.entries()) {
		writeSession(path.join(root, "--Users-test--proj", PARENT_ID, runHash, `run-${i}`), `child-${i}`);
	}
}

describe("nested subagent session recursion (#157)", () => {
	it("syncs nested runs with their own header ids and distinct messages via the plain pi source", async () => {
		const { db, close } = await tempDb();
		const fx = makeTempRoot("prospect-nested-ingest-");
		try {
			writeNestedTree(fx.root, ["2b83bd26", "4b5387b8"]);

			const result = await runSync(db, [new PiFileSource(fx.root)]);
			assert.equal(result.sessionsProcessed, 3); // parent + 2 children
			assert.equal(result.errors.length, 0);

			const sessions = (await db.prepare("SELECT id FROM sessions ORDER BY id").all()) as Array<{ id: string }>;
			assert.deepEqual(sessions.map((s) => s.id), [PARENT_ID, "child-0", "child-1"]);

			// Each session carries exactly its own two messages — nothing was
			// merged into or out of the parent.
			for (const id of ["child-0", "child-1", PARENT_ID]) {
				const rows = (await db
					.prepare("SELECT content_text FROM messages WHERE session_id = ? ORDER BY id")
					.all(id)) as Array<{ content_text: string | null }>;
				assert.equal(rows.length, 2, `${id} has its own two messages`);
				assert.ok(rows.every((r) => r.content_text?.includes(id)), `messages belong to ${id} only`);
			}
			const total = (await db.prepare("SELECT count(*) AS n FROM messages").get()) as { n: number };
			assert.equal(total.n, 6);
		} finally {
			fx.cleanup();
			await close();
		}
	});

	it("re-sync inserts nothing new for these sessions (idempotent)", async () => {
		const { db, close } = await tempDb();
		const fx = makeTempRoot("prospect-nested-ingest-");
		try {
			writeNestedTree(fx.root, ["2b83bd26"]);

			await runSync(db, [new PiFileSource(fx.root)]);
			const result2 = await runSync(db, [new PiFileSource(fx.root)]);
			assert.equal(result2.sessionsProcessed, 0);
			assert.equal(result2.messagesInserted, 0);
			assert.equal(result2.sessionsSkipped, 2);

			const total = (await db.prepare("SELECT count(*) AS n FROM messages").get()) as { n: number };
			assert.equal(total.n, 4);
		} finally {
			fx.cleanup();
			await close();
		}
	});

	it("with the opt-in pi-subagent adapter also present, each file syncs once and the richer adapter wins the claim", async () => {
		const { db, close } = await tempDb();
		const fx = makeTempRoot("prospect-nested-ingest-");
		try {
			writeNestedTree(fx.root, ["2b83bd26", "4b5387b8"]);

			// Same registration order as buildAdapters(): subagent before plain pi.
			const result = await runSync(db, [
				new PiSubagentSource(fx.root),
				new PiFileSource(fx.root),
			]);
			assert.equal(result.errors.length, 0);

			// Three sessions total, no duplicates; the children carry the
			// subadapter's parent linkage because it claimed them first.
			const sessions = (await db
				.prepare("SELECT id, source, parent_session FROM sessions ORDER BY id")
				.all()) as Array<{ id: string; source: string; parent_session: string | null }>;
			assert.deepEqual(sessions, [
				{ id: PARENT_ID, source: "pi", parent_session: null },
				{ id: "child-0", source: "pi-subagent", parent_session: PARENT_ID },
				{ id: "child-1", source: "pi-subagent", parent_session: PARENT_ID },
			]);

			const total = (await db.prepare("SELECT count(*) AS n FROM messages").get()) as { n: number };
			assert.equal(total.n, 6); // synced once, not twice

			// A second invocation over both adapters stays fully idle.
			const again = await runSync(db, [new PiSubagentSource(fx.root), new PiFileSource(fx.root)]);
			assert.equal(again.sessionsProcessed, 0);
			assert.equal(again.messagesInserted, 0);
		} finally {
			fx.cleanup();
			await close();
		}
	});

	it("the depth bound holds through sync: a too-deep tree yields nothing and terminates", async () => {
		const { db, close } = await tempDb();
		const fx = makeTempRoot("prospect-nested-ingest-");
		try {
			let deep = path.join(fx.root, "--Users-test--proj");
			for (let i = 0; i < 20; i++) deep = path.join(deep, `level-${i}`);
			writeSession(deep, "too-deep");

			const result = await runSync(db, [new PiFileSource(fx.root)]);
			assert.equal(result.sessionsProcessed, 0);
			const total = (await db.prepare("SELECT count(*) AS n FROM sessions").get()) as { n: number };
			assert.equal(total.n, 0);
		} finally {
			fx.cleanup();
			await close();
		}
	});
});
