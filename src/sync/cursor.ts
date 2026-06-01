import Database from "better-sqlite3";

export interface Cursor {
	session_id: string;
	last_line: number;
	last_modified: number;
}

export function getCursor(db: Database.Database, sessionFilePath: string): Cursor | null {
	const row = db.prepare(
		"SELECT id AS session_id, last_line, last_modified FROM sessions WHERE file_path = ?",
	).get(sessionFilePath) as { session_id: string; last_line: number; last_modified: number } | undefined;

	if (!row) return null;
	return {
		session_id: row.session_id,
		last_line: row.last_line,
		last_modified: row.last_modified,
	};
}

export function updateCursor(
	db: Database.Database,
	sessionId: string,
	lastLine: number,
	lastModified: number,
): void {
	db.prepare(
		"UPDATE sessions SET last_line = ?, last_modified = ? WHERE id = ?",
	).run(lastLine, lastModified, sessionId);
}