import { type AsyncDatabase } from "../db/async-db.js";

export interface Cursor {
	session_id: string;
	last_line: number;
	last_modified: number;
}

export async function getCursor(db: AsyncDatabase, sessionFilePath: string): Promise<Cursor | null> {
	const row = (await db.prepare(
		"SELECT id AS session_id, last_line, last_modified FROM sessions WHERE file_path = ?",
	).get(sessionFilePath)) as { session_id: string; last_line: number; last_modified: number } | undefined;

	if (!row) return null;
	return {
		session_id: row.session_id,
		last_line: row.last_line,
		last_modified: row.last_modified,
	};
}

export async function updateCursor(
	db: AsyncDatabase,
	sessionId: string,
	lastLine: number,
	lastModified: number,
): Promise<void> {
	await db.prepare(
		"UPDATE sessions SET last_line = ?, last_modified = ? WHERE id = ?",
	).run(lastLine, lastModified, sessionId);
}