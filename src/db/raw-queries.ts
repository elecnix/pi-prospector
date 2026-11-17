import type { AsyncDatabase } from "./async-db.js";
import type { RawCapture, RawState } from "../sync/raw-capture.js";
import { NO_RAW } from "../sync/raw-capture.js";

/** All SQL for the lossless session capture (#400). */

function prep(db: AsyncDatabase, sql: string) {
	return db.prepare(sql);
}

/** What is stored for one session. */
export async function getRawState(db: AsyncDatabase, sessionId: string): Promise<RawState> {
	const last = (await prep(
		db,
		"SELECT byte_start + raw_bytes AS bytes, prefix_sha256 AS prefixSha256 FROM session_raw_chunks WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
	).get(sessionId)) as { bytes: number; prefixSha256: string } | undefined;
	const files = (await prep(db, "SELECT rel_path, sha256 FROM session_raw_files WHERE session_id = ?").all(sessionId)) as Array<{ rel_path: string; sha256: string }>;
	const sidecars: Record<string, string> = {};
	for (const f of files) sidecars[f.rel_path] = f.sha256;
	if (!last) return { ...NO_RAW, sidecars };
	const lines = (await prep(db, "SELECT COALESCE(SUM(line_count), 0) AS n FROM session_raw_chunks WHERE session_id = ?").get(sessionId)) as { n: number };
	return { bytes: last.bytes, lines: lines.n, prefixSha256: last.prefixSha256, sidecars };
}

/**
 * Every indexed session file with the bytes of it stored, in one query: the sync's
 * test for "is this unchanged file fully captured" without a query per session.
 */
export async function getRawProgress(db: AsyncDatabase): Promise<Map<string, { id: string; bytes: number }>> {
	const rows = (await prep(
		db,
		"SELECT s.file_path AS file_path, s.id AS id, COALESCE(SUM(c.raw_bytes), 0) AS bytes FROM sessions s LEFT JOIN session_raw_chunks c ON c.session_id = s.id GROUP BY s.id",
	).all()) as Array<{ file_path: string; id: string; bytes: number }>;
	return new Map(rows.map((r) => [r.file_path, { id: r.id, bytes: r.bytes }]));
}

/**
 * Write one capture. The chunk's sequence number is the next free one, so two
 * calls cannot both claim the same slot; the primary key refuses a second.
 */
export async function storeRawCapture(db: AsyncDatabase, c: RawCapture): Promise<void> {
	if (c.chunk) {
		const ch = c.chunk;
		const next = (await prep(db, "SELECT COALESCE(MAX(seq) + 1, 0) AS seq FROM session_raw_chunks WHERE session_id = ?").get(c.sessionId)) as { seq: number };
		await prep(
			db,
			"INSERT INTO session_raw_chunks (session_id, seq, byte_start, raw_bytes, line_start, line_count, prefix_sha256, rel_path, codec, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(c.sessionId, next.seq, ch.byteStart, ch.rawBytes, ch.lineStart, ch.lineCount, ch.prefixSha256, next.seq === 0 ? c.relPath : null, ch.codec, ch.data);
	}
	for (const f of c.files) {
		await prep(
			db,
			"INSERT INTO session_raw_files (session_id, rel_path, sha256, raw_bytes, codec, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, rel_path) DO UPDATE SET sha256 = excluded.sha256, raw_bytes = excluded.raw_bytes, codec = excluded.codec, data = excluded.data",
		).run(c.sessionId, f.relPath, f.sha256, f.rawBytes, f.codec, f.data);
	}
}

export interface RawChunkRow {
	seq: number;
	byte_start: number;
	raw_bytes: number;
	line_start: number;
	line_count: number;
	rel_path: string | null;
	codec: string;
	data: Uint8Array;
}

export async function getRawChunks(db: AsyncDatabase, sessionId: string): Promise<RawChunkRow[]> {
	return (await prep(
		db,
		"SELECT seq, byte_start, raw_bytes, line_start, line_count, rel_path, codec, data FROM session_raw_chunks WHERE session_id = ? ORDER BY seq",
	).all(sessionId)) as RawChunkRow[];
}

export interface RawFileRow {
	rel_path: string;
	sha256: string;
	raw_bytes: number;
	codec: string;
	data: Uint8Array;
}

export async function getRawFiles(db: AsyncDatabase, sessionId: string): Promise<RawFileRow[]> {
	return (await prep(db, "SELECT rel_path, sha256, raw_bytes, codec, data FROM session_raw_files WHERE session_id = ? ORDER BY rel_path").all(sessionId)) as RawFileRow[];
}

/** True when the session has at least one stored chunk. */
export async function hasRawChunks(db: AsyncDatabase, sessionId: string): Promise<boolean> {
	return (await prep(db, "SELECT 1 AS x FROM session_raw_chunks WHERE session_id = ? LIMIT 1").get(sessionId)) !== undefined;
}
