/**
 * Write a Claude Code session transcript back to disk from the index (#400).
 *
 * The transcript is rebuilt best-effort from the message columns, the extras and
 * the session events (`claude-rebuild.ts`), and a `.restore.json` beside it says,
 * per session, which pieces came back from stored extras, which from the reduced
 * projection alone, and which could not be restored.
 *
 * The file lands at its original path relative to the sessions root, under
 * `outDir`, and its modification time is set just below the one the index
 * recorded. The sync skips a file whose time is not newer than the stored one, so
 * copying an export back into the sessions root re-reads nothing.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AsyncDatabase } from "../db/async-db.js";
import { getSessionEvents, getSessionExtras } from "../db/extras-queries.js";
import { ALWAYS_LOST, PROJECTION_LOSSES, rebuildClaudeRecords, serializeRecords, RESTORED_FROM, type StoredEvent, type StoredMessage } from "./claude-rebuild.js";
import type { MessageExtras } from "./claude-extras.js";

export interface ExportableSession {
	id: string;
	file_path: string;
	project: string;
	cwd: string;
	name: string | null;
	last_modified: number;
	message_count: number;
	parent_session: string | null;
	started_at: string | null;
}

export type ExportOutcome =
	| { kind: "rebuilt"; session: string; path: string; records: number; fromExtras: number; fromProjection: number; omittedStrings: number; notes: Record<string, number> }
	| { kind: "skipped"; session: string; reason: string };

/**
 * The path a session file has under the sessions root, with `/` separators, which
 * is where an export writes it back. A file outside the root (a root that moved
 * since it was indexed) keeps its project directory and name.
 */
export function relPathUnderRoot(root: string, filePath: string, project: string): string {
	const rel = path.relative(root, filePath);
	if (rel && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
	return `${project}/${path.basename(filePath)}`;
}

/** How far below the recorded time an export's modification time is set, in seconds. */
const MTIME_MARGIN_S = 2e-6;

/** `rel` joined under `outDir`, refusing a path that climbs out of it. */
export function insideOut(outDir: string, rel: string): string {
	const target = path.resolve(outDir, rel);
	const root = path.resolve(outDir);
	// A filesystem root already ends in a separator, so it must not get a second one.
	const prefix = root.endsWith(path.sep) ? root : root + path.sep;
	if (target !== root && !target.startsWith(prefix)) throw new Error(`stored path "${rel}" leaves the output directory`);
	return target;
}

/**
 * Write `data` to a temp file, then give it the final name only if nothing has
 * that name. `link` fails with EEXIST when the target exists, which `rename` would
 * silently replace, so a file that appears between the early existence check and
 * this step (Claude Code writing a live session) is never overwritten. Returns
 * false when the target exists.
 */
async function writeAtomic(target: string, data: Uint8Array | string, lastModifiedMs: number, beforeCommit?: (target: string) => Promise<void>): Promise<boolean> {
	await fs.mkdir(path.dirname(target), { recursive: true });
	const tmp = `${target}.tmp-${process.pid}`;
	try {
		await fs.writeFile(tmp, data);
		if (lastModifiedMs > 0) {
			const seconds = lastModifiedMs / 1000 - MTIME_MARGIN_S;
			await fs.utimes(tmp, seconds, seconds);
		}
		if (beforeCommit) await beforeCommit(target);
		try {
			await fs.link(tmp, target);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw err;
		}
		return true;
	} finally {
		await fs.rm(tmp, { force: true });
	}
}

/** Test seam: runs after the temp file is written and before it takes the final name. */
export interface ExportHooks {
	beforeCommit?: (target: string) => Promise<void>;
}

/**
 * Export one session. An existing file at the target is never overwritten: the
 * export reports it and moves on, so running it twice, or into a live sessions
 * root, cannot replace a transcript Claude Code still holds.
 */
export async function exportClaudeSession(db: AsyncDatabase, s: ExportableSession, outDir: string, claudeRoot: string, hooks: ExportHooks = {}): Promise<ExportOutcome> {
	const rel = relPathUnderRoot(claudeRoot, s.file_path, s.project);
	const target = insideOut(outDir, rel);
	const taken: ExportOutcome = { kind: "skipped", session: s.id, reason: `${rel} already exists in the output directory` };
	if (await exists(target)) return taken;

	const messages = (await db
		.prepare(
			"SELECT id, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, usage, model, provider_message_id, stop_reason, error_message FROM messages WHERE session_id = ? ORDER BY rowid",
		)
		.all(s.id)) as StoredMessage[];
	const extras = await getSessionExtras(db, s.id);
	for (const m of messages) {
		const row = extras.get(m.id);
		m.extras = row ? (JSON.parse(row.extras) as MessageExtras) : null;
		m.line = row ? row.line : null;
	}
	const events: StoredEvent[] = (await getSessionEvents(db, s.id)).map((e) => ({ line: e.line, kind: e.kind, ref: e.ref, payload: JSON.parse(e.payload) as unknown }));
	if (messages.length === 0 && events.length === 0) return { kind: "skipped", session: s.id, reason: "no stored messages or events" };

	const { records, notes, sidecars = [] } = rebuildClaudeRecords(s, messages, rel, events);
	if (!(await writeAtomic(target, serializeRecords(records), s.last_modified, hooks.beforeCommit))) return taken;
	for (const side of sidecars) {
		const dest = insideOut(outDir, side.ref);
		if (!(await exists(dest))) await writeAtomic(dest, JSON.stringify(side.payload) + "\n", s.last_modified);
	}
	const fromExtras = notes["messages_with_extras"] ?? 0;
	const fromProjection = messages.length - fromExtras;
	const report = {
		restoredFrom: RESTORED_FROM,
		sessionId: s.id,
		originalPath: s.file_path,
		startedAt: s.started_at,
		parentSession: s.parent_session,
		linesWritten: records.length,
		messagesInIndex: s.message_count,
		messagesRebuiltFromExtras: fromExtras,
		messagesRebuiltFromProjectionOnly: fromProjection,
		eventsRestored: events.filter((e) => e.line >= 0).length,
		sidecarsRestored: sidecars.length,
		omittedStrings: { count: notes["omitted_strings"] ?? 0, bytes: notes["omitted_bytes"] ?? 0 },
		everyRebuiltRecordCarries: { restoredFrom: RESTORED_FROM },
		inferences: notes,
		notRestored: [...(fromProjection > 0 ? PROJECTION_LOSSES.map((l) => `${l} (for the ${fromProjection} messages synced before extras existed)`) : []), ...ALWAYS_LOST],
	};
	await fs.writeFile(target.replace(/\.jsonl$/i, ".restore.json"), JSON.stringify(report, null, 2) + "\n");
	return { kind: "rebuilt", session: s.id, path: target, records: records.length, fromExtras, fromProjection, omittedStrings: notes["omitted_strings"] ?? 0, notes };
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

export async function getExportableSession(db: AsyncDatabase, id: string): Promise<ExportableSession | undefined> {
	return (await db
		.prepare("SELECT id, file_path, project, cwd, name, last_modified, message_count, parent_session, started_at FROM sessions WHERE id = ? AND source = 'claude'")
		.get(id)) as ExportableSession | undefined;
}

/** Every Claude Code session whose source file is gone from disk. */
export async function listMissingClaudeSessions(db: AsyncDatabase): Promise<ExportableSession[]> {
	const all = (await db
		.prepare("SELECT id, file_path, project, cwd, name, last_modified, message_count, parent_session, started_at FROM sessions WHERE source = 'claude' ORDER BY started_at")
		.all()) as ExportableSession[];
	const missing: ExportableSession[] = [];
	for (const s of all) if (!(await exists(s.file_path))) missing.push(s);
	return missing;
}
