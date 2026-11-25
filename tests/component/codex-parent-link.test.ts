/**
 * A codex child run is linked to the row of its parent's rollout file.
 *
 * A codex child's header records its parent as the bare `parent_thread_id` from
 * the rollout, and every codex session row is keyed `<hostId>#<file name>`,
 * because a resumed session writes a second file under the same host id. A row
 * never carries the bare host id, so a link stored as one resolves to nothing:
 * every reader that joins on `parent_session` (message-origin, turn-frustration,
 * delegation-outcomes, the fingerprint's sub-agents) finds no codex child.
 *
 * Sync resolves the link through the parent's own rollout file, the migration
 * repairs the rows indexed before it, and the parent thread itself is never
 * rewritten: a codex session's `parent_thread_id` is always bare, so the rule
 * touches no other harness. Synthetic fixtures only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runSync } from "../../src/sync/index.js";
import { CodexFileSource, codexSessionRowId } from "../../src/sync/sources/codex/index.js";
import { pickCodexParentFile, type ParentFileCandidate } from "../../src/sync/sources/codex/parent-link.js";
import { migrate } from "../../src/db/schema.js";
import { getUnanalyzedSessions, markAnalyzed } from "../../src/db/queries.js";
import { insertSession, tempDb } from "./helpers.js";
import { codexMetaLine, codexMessageLine, codexRolloutFileName, codexSessionId } from "../fixtures/codex-rollout.js";

const PARENT = "codex-parent-thread";
const CHILD = "codex-child-thread";
const MISSING = "codex-missing-thread";
const FIRST = "2026-03-04T09-15-00";
const RESUMED = "2026-03-05T10-00-00";
const CHILD_START = "2026-03-05T08:00:00";
const CHILD_EARLY = "2026-03-05T00:30:00";
const CHILD_LATE = "2026-03-05T12:00:00";

interface Rollout {
	label: string;
	timestamp: string;
	parentThreadId?: string;
}

/** A codex sessions root holding the given rollout files, in Codex's `YYYY/MM/DD` layout. */
function codexRoot(rollouts: Rollout[]): { root: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "prospect-codex-parent-"));
	for (const r of rollouts) {
		const [year, month, day] = r.timestamp.slice(0, 10).split("-") as [string, string, string];
		const dir = path.join(root, year, month, day);
		fs.mkdirSync(dir, { recursive: true });
		const turn = `turn-${r.label}`;
		fs.writeFileSync(
			path.join(dir, codexRolloutFileName(r.label, r.timestamp)),
			[
				codexMetaLine(r.label, { timestamp: `${r.timestamp}.000Z`, ...(r.parentThreadId ? { parentThreadId: r.parentThreadId } : {}) }),
				codexMessageLine("user", `a prompt in ${r.label}`, { kinds: ["user.text"], turnId: turn }),
				codexMessageLine("assistant", `an answer in ${r.label}`, { turnId: turn }),
				"",
			].join("\n"),
		);
	}
	return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** The row id of one rollout file, as the index keys it. */
function rowIdOf(r: Rollout): string {
	return codexSessionRowId(codexSessionId(r.label), codexRolloutFileName(r.label, r.timestamp));
}

async function parentOf(db: Awaited<ReturnType<typeof tempDb>>["db"], id: string): Promise<{ parent_session: string | null; parent_kind: string | null } | undefined> {
	return (await db.prepare("SELECT parent_session, parent_kind FROM sessions WHERE id = ?").get(id)) as
		| { parent_session: string | null; parent_kind: string | null }
		| undefined;
}

describe("codex parent link", () => {
	it("picks the parent rollout file that was current when the child started", () => {
		const first: ParentFileCandidate = { id: "p#rollout-first.jsonl", startedAt: "2026-03-04T09:15:00.000Z" };
		const resumed: ParentFileCandidate = { id: "p#rollout-resumed.jsonl", startedAt: "2026-03-05T10:00:00.000Z" };
		const candidates = [resumed, first];
		// A child spawned before the parent resumed links to the file the parent was in then.
		assert.equal(pickCodexParentFile(candidates, "2026-03-04T12:00:00.000Z"), first.id);
		// A child spawned after it links to the resumed file.
		assert.equal(pickCodexParentFile(candidates, "2026-03-05T11:00:00.000Z"), resumed.id);
		// A child that started after every file, or at the same instant as one, links to the latest.
		assert.equal(pickCodexParentFile(candidates, "2026-03-05T10:00:00.000Z"), resumed.id);
		assert.equal(pickCodexParentFile(candidates, "2026-03-06T00:00:00.000Z"), resumed.id);
		// A child that started before every file, or started at an unknown time, links to the earliest.
		assert.equal(pickCodexParentFile(candidates, "2026-03-04T00:00:00.000Z"), first.id);
		assert.equal(pickCodexParentFile(candidates, ""), first.id);
		assert.equal(pickCodexParentFile([], "2026-03-04T12:00:00.000Z"), null);
	});

	it("links a codex child to the row of its parent's rollout file", async () => {
		const { db, close } = await tempDb();
		const parent: Rollout = { label: PARENT, timestamp: FIRST };
		const child: Rollout = { label: CHILD, timestamp: CHILD_START, parentThreadId: codexSessionId(PARENT) };
		const { root, cleanup } = codexRoot([parent, child]);
		try {
			const result = await runSync(db, [new CodexFileSource(root)]);
			assert.deepEqual(result.errors, []);
			assert.deepEqual(await parentOf(db, rowIdOf(parent)), { parent_session: null, parent_kind: null });
			assert.deepEqual(await parentOf(db, rowIdOf(child)), { parent_session: rowIdOf(parent), parent_kind: "child" });
			// Nothing in the index carries the bare thread id any more.
			const dangling = (await db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE parent_session IS NOT NULL AND parent_session NOT IN (SELECT id FROM sessions)").get()) as { n: number };
			assert.equal(dangling.n, 0);
		} finally {
			cleanup();
			await close();
		}
	});

	it("links a child spawned after its parent resumed to the resumed file, not the first", async () => {
		const { db, close } = await tempDb();
		const first: Rollout = { label: PARENT, timestamp: FIRST };
		const resumed: Rollout = { label: PARENT, timestamp: RESUMED };
		const early: Rollout = { label: CHILD, timestamp: CHILD_EARLY, parentThreadId: codexSessionId(PARENT) };
		const late: Rollout = { label: "codex-child-late", timestamp: CHILD_LATE, parentThreadId: codexSessionId(PARENT) };
		const { root, cleanup } = codexRoot([first, resumed, early, late]);
		try {
			await runSync(db, [new CodexFileSource(root)]);
			assert.equal((await parentOf(db, rowIdOf(early)))?.parent_session, rowIdOf(first));
			assert.equal((await parentOf(db, rowIdOf(late)))?.parent_session, rowIdOf(resumed));
		} finally {
			cleanup();
			await close();
		}
	});

	it("resolves a child whose parent file the same sync discovers after it", async () => {
		const { db, close } = await tempDb();
		// The parent started before the child, and its file sits in a later date
		// directory, so the run discovers and indexes it after the child: only the
		// repair at the end of the sync can resolve the link.
		const parent: Rollout = { label: PARENT, timestamp: "2026-03-04T09:15:00" };
		const child: Rollout = { label: CHILD, timestamp: "2026-03-05T08:00:00", parentThreadId: codexSessionId(PARENT) };
		const { root, cleanup } = codexRoot([parent, child]);
		fs.mkdirSync(path.join(root, "2026", "03", "06"), { recursive: true });
		fs.renameSync(
			path.join(root, "2026", "03", "04", codexRolloutFileName(parent.label, parent.timestamp)),
			path.join(root, "2026", "03", "06", codexRolloutFileName(parent.label, parent.timestamp)),
		);
		try {
			const result = await runSync(db, [new CodexFileSource(root)]);
			assert.deepEqual(result.errors, []);
			assert.deepEqual(await parentOf(db, rowIdOf(child)), { parent_session: rowIdOf(parent), parent_kind: "child" });
		} finally {
			cleanup();
			await close();
		}
	});

	it("repairs a link an index written before the fix left bare, once, and only to an indexed parent", async () => {
		const { db, close } = await tempDb();
		const parent: Rollout = { label: PARENT, timestamp: FIRST };
		const child: Rollout = { label: CHILD, timestamp: CHILD_START, parentThreadId: codexSessionId(PARENT) };
		const { root, cleanup } = codexRoot([parent, child]);
		try {
			await runSync(db, [new CodexFileSource(root)]);
			const childRow = rowIdOf(child);
			// Rewind the child to the state an index written before the fix has.
			await db.prepare("UPDATE sessions SET parent_session = ?, parent_kind = 'child' WHERE id = ?").run(codexSessionId(PARENT), childRow);
			await migrate(db);
			assert.deepEqual(await parentOf(db, childRow), { parent_session: rowIdOf(parent), parent_kind: "child" });
			// The repaired link no longer matches the repair's candidates, so a second
			// pass reads none and writes nothing.
			const before = await parentOf(db, childRow);
			await migrate(db);
			assert.deepEqual(await parentOf(db, childRow), before);
		} finally {
			cleanup();
			await close();
		}
	});

	it("leaves a link whose parent was never indexed bare, and links it once the parent is", async () => {
		const { db, close } = await tempDb();
		const child: Rollout = { label: CHILD, timestamp: CHILD_START, parentThreadId: codexSessionId(MISSING) };
		const { root, cleanup } = codexRoot([child]);
		try {
			await runSync(db, [new CodexFileSource(root)]);
			assert.deepEqual(await parentOf(db, rowIdOf(child)), { parent_session: codexSessionId(MISSING), parent_kind: "child" });

			const parent: Rollout = { label: MISSING, timestamp: FIRST };
			const late = codexRoot([parent]);
			try {
				await runSync(db, [new CodexFileSource(late.root)]);
			} finally {
				late.cleanup();
			}
			assert.deepEqual(await parentOf(db, rowIdOf(child)), { parent_session: rowIdOf(parent), parent_kind: "child" });
		} finally {
			cleanup();
			await close();
		}
	});

	it("queues a repaired codex child and its parent on a database from before the parent-link triggers", async () => {
		const { db, close } = await tempDb();
		try {
			// A database last migrated before #418: no parent-link triggers, so an
			// UPDATE of parent_session queues nothing by itself.
			await db.exec("DROP TRIGGER sessions_parent_link_ai; DROP TRIGGER sessions_parent_link_au;");
			const parentRow = `${codexSessionId(PARENT)}#${codexRolloutFileName(PARENT, FIRST)}`;
			const childRow = `${codexSessionId(CHILD)}#${codexRolloutFileName(CHILD, CHILD_START)}`;
			await insertSession(db, parentRow, `/codex/${codexRolloutFileName(PARENT, FIRST)}`, "", "codex");
			await insertSession(db, childRow, `/codex/${codexRolloutFileName(CHILD, CHILD_START)}`, "", "codex");
			await db.prepare("UPDATE sessions SET started_at = ? WHERE id = ?").run("2026-03-04T09:15:00.000Z", parentRow);
			await db.prepare("UPDATE sessions SET started_at = ?, parent_session = ?, parent_kind = 'child' WHERE id = ?").run("2026-03-05T08:00:00.000Z", codexSessionId(PARENT), childRow);
			for (const id of [parentRow, childRow]) await markAnalyzed(db, id);

			await migrate(db);
			assert.equal((await parentOf(db, childRow))?.parent_session, parentRow);
			// The repair's write goes through the triggers recordParentLinks creates, so
			// the child and the parent it now names are back on the plain-fill queue.
			assert.deepEqual(new Set((await getUnanalyzedSessions(db)).map((s) => s.id)), new Set([childRow, parentRow]));

			// With the link repaired, a later migration has nothing to repair and queues nothing.
			for (const id of [parentRow, childRow]) await markAnalyzed(db, id);
			await migrate(db);
			assert.deepEqual(await getUnanalyzedSessions(db), []);
		} finally {
			await close();
		}
	});

	it("records a failed parent-link repair in the sync result instead of throwing", async () => {
		const { db, close } = await tempDb();
		const parent: Rollout = { label: PARENT, timestamp: FIRST };
		const child: Rollout = { label: CHILD, timestamp: CHILD_START, parentThreadId: codexSessionId(PARENT) };
		const { root, cleanup } = codexRoot([parent, child]);
		// The files are all committed before the repair runs, so a repair that fails is
		// a cleanup failure: the ingest it followed still succeeded and still reports.
		class FailingRepairSource extends CodexFileSource {
			override async linkParents(): Promise<void> {
				throw new Error("link repair exploded");
			}
		}
		try {
			const result = await runSync(db, [new FailingRepairSource(root)]);
			assert.equal(result.sessionsProcessed, 2, "both files were ingested");
			assert.deepEqual(result.errors, ["codex: parent link repair failed: link repair exploded"]);
			// The link the failed repair would have resolved is still stored as recorded.
			assert.equal((await parentOf(db, rowIdOf(child)))?.parent_session, codexSessionId(PARENT));
		} finally {
			cleanup();
			await close();
		}
	});

	it("leaves a bare parent id on another harness alone", async () => {
		const { db, close } = await tempDb();
		try {
			// A pi fork's parent is a session id; a codex parent link is always bare, and
			// resolving one must not rewrite a link another harness recorded.
			await insertSession(db, "some-session", "/sessions/some-session.jsonl");
			await insertSession(db, "pi-fork", "/sessions/fork.jsonl");
			await db.prepare("UPDATE sessions SET parent_session = 'some-session', parent_kind = 'fork' WHERE id = 'pi-fork'").run();
			await migrate(db);
			assert.deepEqual(await parentOf(db, "pi-fork"), { parent_session: "some-session", parent_kind: "fork" });
		} finally {
			await close();
		}
	});
});
