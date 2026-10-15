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
import { makeTempRoot, messageLine, piSessionFileName, sessionHeaderLine, tempDb, writeJsonl } from "./helpers.js";
import { MAX_DISCOVERY_DEPTH } from "../../src/sync/scanner.js";

const PARENT_ID = "aaaa1111-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/**
 * Synthetic JSONL for one session: header + two messages unique to it. The parent
 * is a Pi session file, named as the harness names its own; a child run's session
 * is the `session.jsonl` the pi-subagents extension writes inside a run directory.
 */
function writeSession(dir: string, sessionId: string): void {
	writeJsonl(dir, sessionId === PARENT_ID ? piSessionFileName(sessionId) : "session.jsonl", [
		sessionHeaderLine(sessionId),
		messageLine(sessionId, 1, "user", `hello from ${sessionId}`, "2026-08-19T01:02:20Z"),
		messageLine(sessionId, 2, "assistant", `done (${sessionId})`, "2026-08-19T01:02:25Z"),
	]);
}

/** <root>/--Users-test--proj/<parent>/<parent-session-file> and <runhash>/run-N/session.jsonl */
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

	/**
	 * Recursion descends into every directory below a project, and the host
	 * writes files there that are not sessions at all: pi-subagents drops a
	 * per-child artifact set (including `<runId>_<agent>_<i>_transcript.jsonl`,
	 * its own v1 record format) into `subagent-artifacts/`, and the RPC daemon
	 * keeps a protocol stream in `<name>/out.jsonl`. Both end in `.jsonl`, so the
	 * walk claimed them, `read()` read the file in full and threw "No session
	 * header". A full sync reported 3032 such errors and re-read the same ~59 GB
	 * on every run, because a failed file never advances its cursor.
	 */
	it("claims neither an artifact transcript nor an RPC stream, and reports no errors for them", async () => {
		const { db, close } = await tempDb();
		const fx = makeTempRoot("prospect-nested-ingest-");
		try {
			writeNestedTree(fx.root, ["2b83bd26"]);
			const project = path.join(fx.root, "--Users-test--proj");

			// pi-subagents' artifact transcript: a child run's event stream, whose
			// first record carries no session header.
			writeJsonl(path.join(project, "subagent-artifacts"), "2b83bd26_worker_0_transcript.jsonl", [
				JSON.stringify({
					version: 1,
					recordType: "message",
					source: "foreground",
					runId: "2b83bd26",
					agent: "worker",
					childIndex: 0,
					cwd: "/home/user/proj",
					role: "user",
					text: "hello",
					message: { role: "user", content: "hello" },
				}),
			]);
			// The RPC daemon's protocol stream, one level below the project dir.
			writeJsonl(path.join(project, "an-rpc-run"), "out.jsonl", [
				JSON.stringify({ type: "extension_ui_request", id: "7e011d41", method: "notify" }),
			]);

			const result = await runSync(db, [new PiFileSource(fx.root)]);
			assert.deepEqual(result.errors, [], "non-session files are not errors");

			// The parent and its child run are the only sessions; neither
			// non-session file produced one.
			const paths = (await db.prepare("SELECT file_path FROM sessions ORDER BY file_path").all()) as Array<{ file_path: string }>;
			assert.equal(paths.length, 2);
			assert.ok(
				paths.every((p) => !p.file_path.includes("subagent-artifacts") && !p.file_path.includes("out.jsonl")),
				`only session files are ingested: ${paths.map((p) => p.file_path).join(", ")}`,
			);
		} finally {
			fx.cleanup();
			await close();
		}
	});

	it("the depth bound holds through sync: a session past it is never reached", async () => {
		const { db, close } = await tempDb();
		const fx = makeTempRoot("prospect-nested-ingest-");
		try {
			const project = path.join(fx.root, "--Users-test--proj");
			let deep = project;
			for (let i = 0; i <= MAX_DISCOVERY_DEPTH + 3; i++) deep = path.join(deep, `level-${i}`);

			// Both files are pi sessions by name: the shallow one a session file, the
			// deep one a run-N session.jsonl. A name-based claim accepts either at any
			// depth, so the depth bound is the only thing that can separate them, and
			// the assertion on the shallow one is what fails if it is not enforced.
			writeSession(project, PARENT_ID);
			writeSession(path.join(deep, "run-0"), "too-deep");

			const result = await runSync(db, [new PiFileSource(fx.root)]);
			assert.equal(result.sessionsProcessed, 1, "the within-bound session syncs, the deep one is not reached");
			const rows = (await db.prepare("SELECT id FROM sessions").all()) as Array<{ id: string }>;
			assert.deepEqual(rows.map((r) => r.id), [PARENT_ID]);
		} finally {
			fx.cleanup();
			await close();
		}
	});
});
