/**
 * Write a Claude Code session transcript back to disk from the index (#400).
 *
 * Two routes. A session synced with raw capture on has its original bytes, and the
 * export writes them back unchanged, with the sidecar files beside it. A session
 * synced before that has only the reduced projection, and the export rebuilds
 * what it can (`claude-rebuild.ts`) and writes a `.restore.json` beside the file
 * that says what it could not.
 *
 * Either way the file lands at its original path relative to the sessions root,
 * under `outDir`, and its modification time is set just below the one the index
 * recorded. The sync skips a file whose time is not newer than the stored one, so
 * copying an export back into the sessions root re-reads nothing.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AsyncDatabase } from "../db/async-db.js";
import { getRawChunks, getRawFiles } from "../db/raw-queries.js";
import { decompress, relPathUnderRoot, sha256 } from "./raw-capture.js";
import { NOT_RESTORED, rebuildClaudeRecords, serializeRecords, RESTORED_FROM, type StoredMessage } from "./claude-rebuild.js";

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
	| { kind: "exact"; session: string; path: string; bytes: number; sidecars: number }
	| { kind: "rebuilt"; session: string; path: string; records: number; notes: Record<string, number> }
	| { kind: "skipped"; session: string; reason: string };

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

async function writeAtomic(target: string, data: Uint8Array | string, lastModifiedMs: number): Promise<void> {
	await fs.mkdir(path.dirname(target), { recursive: true });
	const tmp = `${target}.tmp-${process.pid}`;
	await fs.writeFile(tmp, data);
	if (lastModifiedMs > 0) {
		const seconds = lastModifiedMs / 1000 - MTIME_MARGIN_S;
		await fs.utimes(tmp, seconds, seconds);
	}
	await fs.rename(tmp, target);
}

/**
 * Export one session. An existing file at the target is never overwritten: the
 * export reports it and moves on, so running it twice, or into a live sessions
 * root, cannot replace a transcript Claude Code still holds.
 */
export async function exportClaudeSession(db: AsyncDatabase, s: ExportableSession, outDir: string, claudeRoot: string): Promise<ExportOutcome> {
	const chunks = await getRawChunks(db, s.id);
	const rel = chunks[0]?.rel_path ?? relPathUnderRoot(claudeRoot, s.file_path, s.project);
	const target = insideOut(outDir, rel);
	if (await exists(target)) return { kind: "skipped", session: s.id, reason: `${rel} already exists in the output directory` };

	if (chunks.length > 0) {
		const parts: Buffer[] = [];
		let expectedStart = 0;
		for (const c of chunks) {
			if (c.byte_start !== expectedStart) throw new Error(`session ${s.id}: stored chunks leave a gap at byte ${expectedStart}`);
			const raw = decompress(c.codec, c.data);
			if (raw.length !== c.raw_bytes) throw new Error(`session ${s.id}: chunk ${c.seq} holds ${raw.length} bytes, expected ${c.raw_bytes}`);
			parts.push(raw);
			expectedStart += raw.length;
		}
		const content = Buffer.concat(parts);
		await writeAtomic(target, content, s.last_modified);
		const files = await getRawFiles(db, s.id);
		for (const f of files) {
			const bytes = decompress(f.codec, f.data);
			if (sha256(bytes) !== f.sha256) throw new Error(`session ${s.id}: stored sidecar ${f.rel_path} fails its checksum`);
			const dest = insideOut(outDir, f.rel_path);
			if (!(await exists(dest))) await writeAtomic(dest, bytes, s.last_modified);
		}
		return { kind: "exact", session: s.id, path: target, bytes: content.length, sidecars: files.length };
	}

	const messages = (await db
		.prepare(
			"SELECT id, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, usage, model, provider_message_id, stop_reason, error_message FROM messages WHERE session_id = ? ORDER BY rowid",
		)
		.all(s.id)) as StoredMessage[];
	if (messages.length === 0) return { kind: "skipped", session: s.id, reason: "no stored messages and no stored original bytes" };
	const { records, notes } = rebuildClaudeRecords(s, messages, rel);
	await writeAtomic(target, serializeRecords(records), s.last_modified);
	const report = {
		restoredFrom: RESTORED_FROM,
		sessionId: s.id,
		originalPath: s.file_path,
		startedAt: s.started_at,
		parentSession: s.parent_session,
		recordsWritten: records.length,
		messagesInIndex: s.message_count,
		content: "rebuilt from the reduced projection the index kept: no original bytes were stored for this session",
		everyRebuiltRecordCarries: { restoredFrom: RESTORED_FROM },
		inferences: notes,
		notRestored: NOT_RESTORED,
	};
	await fs.writeFile(target.replace(/\.jsonl$/i, ".restore.json"), JSON.stringify(report, null, 2) + "\n");
	return { kind: "rebuilt", session: s.id, path: target, records: records.length, notes };
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
