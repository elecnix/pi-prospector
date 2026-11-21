/**
 * A pi child run is linked to the session that spawned it (#416).
 *
 * Pi keeps a session's child runs under a directory named after the session file,
 * `<project>/<stem>/<runhash>/run-N/session.jsonl`, and a run's own header names no
 * parent. The always-on `pi` source claims those files when the opt-in
 * `pi-subagent` source is not configured, so it has to read the parent from the
 * path too. Rows indexed before it did are re-linked by the migration, because sync
 * never reads a file whose mtime has not changed.
 *
 * Synthetic fixtures only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { runSync } from "../../src/sync/index.js";
import { PiFileSource } from "../../src/sync/sources/pi/index.js";
import { migrate } from "../../src/db/schema.js";
import { insertSession, makeTempRoot, messageLine, piSessionFileName, sessionHeaderLine, tempDb, writeJsonl } from "./helpers.js";

const PARENT_ID = "aaaa1111-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PARENT_STEM = `2026-08-19T01-00-00Z_${PARENT_ID}`;
const MISSING_ID = "ffff2222-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const MISSING_STEM = `2026-08-19T02-00-00Z_${MISSING_ID}`;
const PROJECT = "--Users-test--proj";

function writeSession(dir: string, fileName: string, sessionId: string): void {
	writeJsonl(dir, fileName, [sessionHeaderLine(sessionId), messageLine(sessionId, 1, "user", `hello from ${sessionId}`, "2026-08-19T01:02:20Z")]);
}

async function parentOf(db: Awaited<ReturnType<typeof tempDb>>["db"], id: string): Promise<string | null | undefined> {
	const row = (await db.prepare("SELECT parent_session FROM sessions WHERE id = ?").get(id)) as { parent_session: string | null } | undefined;
	return row?.parent_session;
}

describe("child run parent (#416)", () => {
	it("the pi source links a child run, flat or nested, to the session whose directory holds it", async () => {
		const { db, close } = await tempDb();
		const fx = makeTempRoot("prospect-child-run-");
		try {
			const projectDir = path.join(fx.root, PROJECT);
			writeSession(projectDir, piSessionFileName(PARENT_ID), PARENT_ID);
			const runDir = path.join(projectDir, PARENT_STEM, "2b83bd26", "run-0");
			writeSession(runDir, "session.jsonl", "child-flat");
			// A run a child run started: pi writes it under the child's own `session` directory.
			writeSession(path.join(runDir, "session", "4b5387b8", "run-1"), "session.jsonl", "child-nested");

			const result = await runSync(db, [new PiFileSource(fx.root)]);
			assert.deepEqual(result.errors, []);
			assert.equal(await parentOf(db, PARENT_ID), null);
			assert.equal(await parentOf(db, "child-flat"), PARENT_ID);
			assert.equal(await parentOf(db, "child-nested"), PARENT_ID);
			const kinds = (await db.prepare("SELECT parent_kind FROM sessions WHERE id IN ('child-flat', 'child-nested')").all()) as Array<{ parent_kind: string | null }>;
			assert.deepEqual(kinds.map((k) => k.parent_kind), ["child", "child"]);
		} finally {
			await close();
			fx.cleanup();
		}
	});

	it("the migration links child runs indexed with no parent, once, and only to an indexed session", async () => {
		const { db, close } = await tempDb();
		try {
			const root = "/sessions/" + PROJECT;
			await insertSession(db, PARENT_ID, `${root}/${PARENT_STEM}.jsonl`);
			await insertSession(db, "child-flat", `${root}/${PARENT_STEM}/2b83bd26/run-0/session.jsonl`);
			await insertSession(db, "child-nested", `${root}/${PARENT_STEM}/2b83bd26/run-0/session/4b5387b8/run-1/session.jsonl`);
			await insertSession(db, "child-uuid-run", `${root}/${PARENT_STEM}/fffdcabd-711c-4e5e-ba5f-d9d77cb4afb7/run-0/session.jsonl`);
			// The session this run's path names was never indexed: no parent is written.
			await insertSession(db, "child-of-missing", `${root}/${MISSING_STEM}/2b83bd26/run-0/session.jsonl`);
			// Not a run's session file, though it sits under a session directory.
			await insertSession(db, "not-a-run", `${root}/${PARENT_STEM}/2b83bd26/run-0/other.jsonl`);
			// A run whose parent is already recorded keeps it.
			await insertSession(db, "child-linked", `${root}/${PARENT_STEM}/2b83bd26/run-2/session.jsonl`);
			// Rows indexed before parent_kind existed: a pi fork, and another harness's child agent.
			await insertSession(db, "pi-fork", `${root}/2026-08-19T03-00-00Z_${MISSING_ID}.jsonl`);
			await insertSession(db, "claude-child", "/claude/agent-a1.jsonl", "", "claude");
			for (const [id, parent] of [["child-linked", "recorded-parent"], ["pi-fork", PARENT_ID], ["claude-child", "claude-parent"]]) {
				await db.prepare("UPDATE sessions SET parent_session = ?, parent_kind = NULL WHERE id = ?").run(parent, id);
			}

			const snapshot = async () => (await db.prepare("SELECT id, parent_session, parent_kind FROM sessions ORDER BY id").all()) as Array<Record<string, unknown>>;

			await migrate(db);
			const once = await snapshot();
			assert.deepEqual(once, [
				{ id: PARENT_ID, parent_session: null, parent_kind: null },
				{ id: "child-flat", parent_session: PARENT_ID, parent_kind: "child" },
				{ id: "child-linked", parent_session: "recorded-parent", parent_kind: "child" },
				{ id: "child-nested", parent_session: PARENT_ID, parent_kind: "child" },
				{ id: "child-of-missing", parent_session: null, parent_kind: null },
				{ id: "child-uuid-run", parent_session: PARENT_ID, parent_kind: "child" },
				{ id: "claude-child", parent_session: "claude-parent", parent_kind: "child" },
				{ id: "not-a-run", parent_session: null, parent_kind: null },
				{ id: "pi-fork", parent_session: PARENT_ID, parent_kind: "fork" },
			]);

			await migrate(db);
			assert.deepEqual(await snapshot(), once);
		} finally {
			await close();
		}
	});

	it("the migration links a run whose parent is indexed later", async () => {
		const { db, close } = await tempDb();
		try {
			const root = "/sessions/" + PROJECT;
			await insertSession(db, "child-of-missing", `${root}/${MISSING_STEM}/2b83bd26/run-0/session.jsonl`);
			await migrate(db);
			assert.equal(await parentOf(db, "child-of-missing"), null);
			await insertSession(db, MISSING_ID, `${root}/${MISSING_STEM}.jsonl`);
			await migrate(db);
			assert.equal(await parentOf(db, "child-of-missing"), MISSING_ID);
		} finally {
			await close();
		}
	});
});
