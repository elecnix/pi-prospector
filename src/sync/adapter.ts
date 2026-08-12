/**
 * SessionSourceAdapter — the contract a session source must implement.
 *
 * A source knows how to discover the sessions it owns and how to parse one
 * session into DB-ready rows. The sync loop handles cursor checks, transaction
 * wrapping, and cursor updates — the adapter owns only source-specific logic.
 */
import type { DiscoveredSession } from "../types.js";
import type { SessionInsert, MessageInsert } from "../db/queries.js";

export interface ParsedSession {
	/** Ready for upsertSessions(). */
	session: SessionInsert;
	/** Ready for insertMessage(). */
	messages: MessageInsert[];
	/** Number of source units processed (lines for files, rows for DB sources). */
	processedCount: number;
	/** Timestamp to record in the cursor after successful insert. */
	processedTimestamp: number;
	/** Number of fork resolutions performed (non-zero only for Pi). */
	forksResolved: number;
}

export interface SessionSourceAdapter {
	/** The `source` tag stored on every session/message row this adapter produces. */
	readonly source: string;

	/**
	 * Root directory whose child-run artifact metadata is ingested beside this
	 * source's sessions, when the host writes artifacts under it (Pi only).
	 * Absent for sources that have none — the sync loop skips artifact ingest.
	 */
	readonly artifactsRoot?: string;

	/** Enumerate the sessions this source knows about right now. */
	discover(): Promise<DiscoveredSession[]>;

	/**
	 * Parse one session from the given resume point.
	 *
	 * The adapter handles all source-specific logic: file reading, line parsing,
	 * fork resolution, tool-name mapping, etc. The caller handles cursor checks,
	 * transaction wrapping, cursor updates, and error recording.
	 *
	 * @param disc - the discovered session to parse
	 * @param resumeLine - line/event offset to resume from (0 = full parse)
	 */
	read(disc: DiscoveredSession, resumeLine: number): Promise<ParsedSession>;
}
