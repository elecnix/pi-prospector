/**
 * SessionSourceAdapter — the contract a session source must implement.
 *
 * A source knows how to discover the sessions it owns and how to parse one
 * session into DB-ready rows. The sync loop handles cursor checks, transaction
 * wrapping, and cursor updates — the adapter owns only source-specific logic.
 */
import type { DiscoveredSession } from "../types.js";
import type { SessionInsert, MessageInsert, BackgroundTaskInsert } from "../db/queries.js";
import type { MessageExtrasInsert, SessionEventInsert } from "../db/extras-queries.js";

export interface ParsedSession {
	/** Ready for upsertSessions(). */
	session: SessionInsert;
	/** Ready for insertMessage(). */
	messages: MessageInsert[];
	/**
	 * Background-task completions this source recorded, ready for
	 * `upsertBackgroundTask()`. Empty for sources that record none.
	 *
	 * A backgrounded call returns at once and the transcript's tool result for
	 * it is only an acknowledgement, so the real end of the work is a separate
	 * record. Without it a background call times as near-instant (issue #306).
	 */
	backgroundTasks?: BackgroundTaskInsert[];
	/**
	 * What the source carried that no message column holds (#400): one entry per
	 * message in `messages` it has any record of, and one per source record that is
	 * not a message. Both are optional, so a source fills them when it can rebuild its
	 * own transcript and leaves them out when it cannot.
	 */
	/**
	 * True when the file is a rebuild an export wrote, not an original transcript. The
	 * sync then inserts messages it does not have and writes nothing else from the file.
	 */
	rebuilt?: boolean;
	/** For a batched read: true on the final batch of the file. */
	lastBatch?: boolean;
	extras?: MessageExtrasInsert[];
	events?: SessionEventInsert[];
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
	 * The machine whose sessions this adapter reads, recorded on every session it
	 * discovers. Set when the composition root builds one adapter per configured
	 * root, and absent for a single local root, where the sync records the local
	 * hostname instead.
	 */
	readonly host?: string;

	/**
	 * Claim order for the sync loop: `runSync` claims each file once and the
	 * first adapter wins, so adapters are tried in ascending priority order.
	 * A source that declares none sorts after every built-in — a custom source
	 * therefore fills in sessions no built-in claims and cannot take nested
	 * child runs from pi-subagent unless it deliberately declares a lower
	 * priority than 50.
	 */
	readonly priority?: number;

	/**
	 * Whether sync loads this source without config `sources` naming it.
	 * Absent means true. A built-in that is opt-in (pi-subagent) declares false.
	 */
	readonly enabledByDefault?: boolean;

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

	/**
	 * Parse one session as a stream of batches, so no more than one batch of the file is
	 * in memory. Each batch is a `ParsedSession` for the lines it covers: `processedCount`
	 * is the cursor after it, and `lastBatch` is true on the final one. A source that
	 * implements it is read this way by the sync loop; one that does not is read whole
	 * by `read()`, and a file too large for that is skipped with a classified error.
	 */
	readBatches?(disc: DiscoveredSession, resumeLine: number): AsyncGenerator<ParsedSession>;
}

/** Priority of an adapter that declares none: after every built-in. */
export const DEFAULT_SOURCE_PRIORITY = 100;

/**
 * Order adapters for the sync loop's claiming: ascending priority, stable for
 * equal priorities, so the order adapters were loaded in breaks ties. Returns a
 * new array; the input is not mutated.
 */
export function sortSourceAdapters(adapters: SessionSourceAdapter[]): SessionSourceAdapter[] {
	return [...adapters].sort((a, b) => (a.priority ?? DEFAULT_SOURCE_PRIORITY) - (b.priority ?? DEFAULT_SOURCE_PRIORITY));
}


/** Put the batches of one file together as one `ParsedSession`, for a caller that wants the whole read. */
export async function collectBatches(batches: AsyncGenerator<ParsedSession>): Promise<ParsedSession> {
	let out: ParsedSession | null = null;
	for await (const b of batches) {
		if (!out) {
			out = { ...b, messages: [...b.messages], extras: [...(b.extras ?? [])], events: [...(b.events ?? [])], backgroundTasks: [...(b.backgroundTasks ?? [])] };
			continue;
		}
		out.messages.push(...b.messages);
		out.extras!.push(...(b.extras ?? []));
		out.events!.push(...(b.events ?? []));
		out.backgroundTasks!.push(...(b.backgroundTasks ?? []));
		out.session = b.session;
		out.processedCount = b.processedCount;
		out.processedTimestamp = b.processedTimestamp;
		out.forksResolved += b.forksResolved;
		out.rebuilt = b.rebuilt;
	}
	if (!out) throw new Error("a batched read yielded no batch");
	return out;
}
