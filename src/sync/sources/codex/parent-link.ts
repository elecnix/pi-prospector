/**
 * Which codex session row a child run's parent link resolves to.
 *
 * A codex child records its parent in the rollout header as the bare
 * `parent_thread_id`, and no session row carries that id: a row is keyed
 * `<hostId>#<rollout file name>` (see `codexSessionRowId`), because a resumed
 * session writes a second file under the same host id. So the link has to be
 * resolved through the parent's own rollout files, whose names carry the host id
 * of the thread they hold.
 *
 * {@link repairCodexParents} resolves every link still stored as a bare thread id.
 * The codex source runs it at the end of a sync, through its `linkParents` hook,
 * and the migration runs it when a command opens the database, which repairs the
 * rows indexed before sync resolved the link at all. The rule lives here, so sync
 * and the repair can never disagree about which file a link names.
 */
import { Type, type Static } from "typebox";
import type { AsyncDatabase } from "../../../db/async-db.js";
import { prep } from "../../../db/prepared.js";

/** One rollout file of a parent thread, as far as picking one needs: its row id and when the file's session started. */
export const ParentFileCandidate = Type.Object({
	id: Type.String(),
	/** The session's own start, from its `session_meta`; empty when the file recorded none. */
	startedAt: Type.String(),
});
export type ParentFileCandidate = Static<typeof ParentFileCandidate>;

/**
 * The rollout file of a parent thread that was current when the child started.
 *
 * A parent with several files is a session that was resumed, and each file is a
 * stretch of that session's life. A child was spawned by the stretch that was
 * running at the time, so the link names the latest file that started at or
 * before the child, or the earliest file when every file started after it (the
 * parent's own timestamps disagree with the child's, or the child's is unknown).
 * A link to the thread itself has no better answer: the files would otherwise be
 * interchangeable, and picking the first would send a child spawned after a
 * resume to a file that had already ended.
 */
export function pickCodexParentFile(candidates: readonly ParentFileCandidate[], childStartedAt: string): string | null {
	if (candidates.length === 0) return null;
	const ordered = [...candidates].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
	let picked = ordered[0]!;
	if (childStartedAt) {
		for (const candidate of ordered) {
			if (candidate.startedAt && candidate.startedAt > childStartedAt) break;
			picked = candidate;
		}
	}
	return picked.id;
}

/**
 * Resolve every codex parent link still stored as a bare thread id.
 *
 * Runs at the end of `migrate()`, so a database indexed before sync resolved the
 * link is repaired the first time a command opens it, and at the end of a sync
 * through the source's `linkParents` hook, so a child whose parent file the run
 * indexed after it is linked without waiting for the next command, and a child
 * indexed with only part of its header is resolved once the whole file is read.
 *
 * Only a codex row's link is touched, and only when a row holds one of the
 * parent's files; a link that names nothing keeps the thread id, so a later pass
 * links it when the parent is indexed. Idempotent: a repaired row's parent
 * carries the `#`, so a second pass does not read it.
 */
export async function repairCodexParents(db: AsyncDatabase): Promise<void> {
	const children = (await prep(
		db,
		`SELECT parent_session, started_at FROM sessions
		  WHERE source = 'codex' AND TRIM(COALESCE(parent_session, '')) <> '' AND instr(parent_session, '#') = 0`,
	).all()) as Array<{ parent_session: string; started_at: string | null }>;
	if (children.length === 0) return;
	// One parent thread may have many children. Its files are the same for all of
	// them, so they are read once, and the rule picks per child.
	const files = new Map<string, ParentFileCandidate[]>();
	const candidatesOf = async (threadId: string): Promise<ParentFileCandidate[]> => {
		const cached = files.get(threadId);
		if (cached) return cached;
		const rows = (await prep(
			db,
			`SELECT id, started_at FROM sessions
			  WHERE source = 'codex' AND substr(id, 1, ?) = ?
			  ORDER BY started_at, id`,
		).all(`${threadId}#`.length, `${threadId}#`)) as Array<{ id: string; started_at: string | null }>;
		const read = rows.map((row) => ({ id: row.id, startedAt: row.started_at ?? "" }));
		files.set(threadId, read);
		return read;
	};
	const setParent = prep(db, "UPDATE sessions SET parent_session = ? WHERE source = 'codex' AND parent_session = ? AND started_at IS ?");
	await db.transaction(async () => {
		for (const child of children) {
			const resolved = pickCodexParentFile(await candidatesOf(child.parent_session), child.started_at ?? "");
			if (!resolved) continue;
			await setParent.run(resolved, child.parent_session, child.started_at);
		}
	})();
}
