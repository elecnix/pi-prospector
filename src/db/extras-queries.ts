import type { AsyncDatabase } from "./async-db.js";

/** All SQL for the session extras (#400): what a source carried that no message column holds. */

export interface MessageExtrasInsert {
	message_id: string;
	/** The record's line in the source file. */
	line: number;
	/** JSON: see `claude-extras.ts` for the keys a Claude Code source writes. */
	extras: string;
}

export interface SessionEventInsert {
	session_id: string;
	/** The record's line in the source file, or -1 for a file written beside the session. */
	line: number;
	/** The source's own name for the record: its `type`, `unparsed`, or `sidecar`. */
	kind: string;
	/** For a sidecar, its path relative to the sessions root, which tells two files of one session apart. "" for a record: the column is part of the primary key, which cannot hold NULL. */
	ref: string;
	payload: string;
}

/**
 * Store a message's extras, only when the message row belongs to `sessionId`. The
 * index keeps each message once, under the first session that had it, so a second
 * file that repeats the id (a resumed or forked session) must not put its own line
 * number and fields on the first session's message.
 */
export async function insertMessageExtras(db: AsyncDatabase, e: MessageExtrasInsert, sessionId: string): Promise<void> {
	await db
		.prepare(
			"INSERT OR IGNORE INTO message_extras (message_id, line, extras) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM messages WHERE id = ? AND session_id = ?)",
		)
		.run(e.message_id, e.line, e.extras, e.message_id, sessionId);
}

/**
 * Records at a line never change, so a second write of one is ignored. A sidecar
 * (line -1) is a whole file that can change, so its row is replaced. A session can
 * have several sidecars: each is a row of its own, keyed by its path.
 */
export async function upsertSessionEvent(db: AsyncDatabase, e: SessionEventInsert): Promise<void> {
	await db
		.prepare(
			"INSERT INTO session_events (session_id, line, kind, ref, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, line, ref) DO UPDATE SET kind = excluded.kind, ref = excluded.ref, payload = excluded.payload WHERE excluded.line < 0",
		)
		.run(e.session_id, e.line, e.kind, e.ref, e.payload);
}

export interface StoredExtrasRow {
	message_id: string;
	line: number;
	extras: string;
}

export async function getSessionExtras(db: AsyncDatabase, sessionId: string): Promise<Map<string, StoredExtrasRow>> {
	const rows = (await db
		.prepare("SELECT x.message_id, x.line, x.extras FROM message_extras x JOIN messages m ON m.id = x.message_id WHERE m.session_id = ?")
		.all(sessionId)) as StoredExtrasRow[];
	return new Map(rows.map((r) => [r.message_id, r]));
}

export interface StoredEventRow {
	line: number;
	kind: string;
	ref: string;
	payload: string;
}

export async function getSessionEvents(db: AsyncDatabase, sessionId: string): Promise<StoredEventRow[]> {
	return (await db.prepare("SELECT line, kind, ref, payload FROM session_events WHERE session_id = ? ORDER BY line").all(sessionId)) as StoredEventRow[];
}
