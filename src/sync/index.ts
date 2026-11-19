import { type AsyncDatabase } from "../db/async-db.js";
import { insertMessageExtras, upsertSessionEvent } from "../db/extras-queries.js";
import { faultClassOf } from "./faults.js";
import { getSessionRow, upsertSession, getCursor, updateCursor, updateMessageCount, insertMessage, countMessages, upsertBackgroundTask } from "../db/queries.js";
import type { DiscoverOptions } from "./scanner.js";
import { ingestSubagentArtifacts } from "./subagent-artifacts.js";
import type { SourceSyncSummary, SyncResult } from "../types.js";
import type { SessionSourceAdapter } from "./adapter.js";

/**
 * Ingest every session discovered by the given adapters.
 *
 * Each adapter owns discovery and parsing for its source. The sync loop
 * handles cursor checks, transaction wrapping, cursor updates, and error
 * recording — the adapter owns only source-specific logic.
 *
 * Previously took two filesystem paths and dispatched on a closed
 * `SessionSource` enum. Now takes adapters and lets each adapter define
 * its own discovery and parsing strategy (#138).
 *
 * An optional `opts` scope narrows the ingest to a project or harness — the
 * fresh-install escape hatch that keeps a one-project sync from paying for
 * every session on disk. The harness filter selects whole adapters; the
 * project filter applies to whatever each selected adapter discovered.
 */
/** The session columns a read may change, not counting the cursor and the counts that every read moves. */
const SESSION_FIELDS = ["file_path", "project", "source", "cwd", "parent_session", "started_at", "name", "tool_inventory", "host"] as const;

export async function runSync(
	db: AsyncDatabase,
	adapters: SessionSourceAdapter[],
	opts?: DiscoverOptions & { reread?: boolean },
): Promise<SyncResult> {
	const result: SyncResult = {
		bySource: {},
		sessionsProcessed: 0,
		sessionsSkipped: 0,
		messagesInserted: 0,
		forksResolved: 0,
		subagentRunsProcessed: 0,
		subagentRunsSkipped: 0,
		errors: [],
	};

	const active = opts?.source ? adapters.filter((a) => a.source === opts.source) : adapters;

	// The same file may be claimed by more than one adapter — e.g. the shared
	// walker now recurses into nested run directories (#157) while an opt-in
	// "pi-subagent" adapter also discovers them for their richer parent linkage.
	// Within one sync invocation the first claim wins and later duplicates are
	// skipped: syncing one file twice would double-insert its messages under two
	// source tags. Cheap identity guard; cross-run duplication stays impossible
	// because cursors are keyed by file path.
	const claimed = new Set<string>();
	const summary = (source: string): SourceSyncSummary =>
		(result.bySource[source] ??= { visited: 0, sessionsAdded: 0, messagesAdded: 0, sessionFieldsChanged: 0, extrasAdded: 0, eventsAdded: 0, rebuiltSkipped: 0, errors: {} });

	for (const adapter of active) {
		for (const disc of await adapter.discover()) {
			try {
				if (claimed.has(disc.filePath)) continue;
				if (opts?.project && disc.project !== opts.project) continue;
				claimed.add(disc.filePath);

				const cursor = await getCursor(db, disc.filePath);

				// Skip unchanged files
				// `reread` ignores the cursor: it is how a session indexed before the extras
				// existed gains them. Messages insert with INSERT OR IGNORE, so a message
				// already stored keeps its row.
				if (!opts?.reread && cursor && cursor.last_modified >= disc.mtime) {
					result.sessionsSkipped++;
					continue;
				}

				const parsed = await adapter.read(disc, opts?.reread ? 0 : (cursor?.last_line ?? 0));

				// Every DB write for this session commits as one unit. The insert
				// loop, the cursor advance and the message count are deliberately
				// inside the same transaction: if anything here fails partway,
				// SQLite rolls the whole session back atomically — no partial rows
				// *and* no advanced `last_line` — so a resync reprocesses the file
				// from the old cursor instead of skipping rows that were never
				// committed (issue #59).
				const sum = summary(disc.source);
				sum.visited++;
				let inserted = 0;
				let extrasAdded = 0;
				let eventsAdded = 0;
				let fieldsChanged = false;
				let added = false;
				let rebuiltSkipped = false;
				const syncSession = db.transaction(async () => {
					inserted = 0;
					extrasAdded = 0;
					eventsAdded = 0;
					// The host travels with the adapter, not with the transcript: a mirrored tree keeps
					// the host name of the machine that wrote it, and a local root gets this machine.
					if (adapter.host) parsed.session.host = adapter.host;
					const existing = await getSessionRow(db, parsed.session.id);
					// A rebuild an export wrote is never a source of session fields, extras, events or a
					// cursor. Messages it holds that the index lacks still insert, and a session the index
					// has never seen is created from it so it is not lost.
					if (parsed.rebuilt && existing) {
						for (const m of parsed.messages) {
							if (await insertMessage(db, m)) inserted++;
						}
						rebuiltSkipped = true;
						return;
					}
					await upsertSession(db, parsed.session);
					for (const m of parsed.messages) {
						if (await insertMessage(db, m)) inserted++;
					}
					if (!parsed.rebuilt) {
						for (const x of parsed.extras ?? []) if (await insertMessageExtras(db, x, parsed.session.id)) extrasAdded++;
						for (const ev of parsed.events ?? []) if (await upsertSessionEvent(db, ev)) eventsAdded++;
					}
					// A backgrounded call's completion record, when the source has one.
					// Same transaction as the messages: the completion is a fact
					// about a call in this session, so it lands with it or not at all.
					for (const t of parsed.backgroundTasks ?? []) {
						await upsertBackgroundTask(db, t);
					}
					await updateCursor(db, parsed.session.id, parsed.processedCount, parsed.processedTimestamp);
					const total = await countMessages(db, parsed.session.id);
					await updateMessageCount(db, parsed.session.id, total);
					const now = await getSessionRow(db, parsed.session.id);
					if (!existing) added = true;
					else if (now) fieldsChanged = SESSION_FIELDS.some((k) => existing[k] !== now[k]);
				});
				await syncSession();

				if (rebuiltSkipped) {
					sum.rebuiltSkipped++;
					sum.messagesAdded += inserted;
					result.messagesInserted += inserted;
					continue;
				}
				sum.messagesAdded += inserted;
				sum.extrasAdded += extrasAdded;
				sum.eventsAdded += eventsAdded;
				if (added) sum.sessionsAdded++;
				if (fieldsChanged) sum.sessionFieldsChanged++;
				result.sessionsProcessed++;
				result.messagesInserted += inserted;
				result.forksResolved += parsed.forksResolved;
			} catch (err) {
				result.errors.push(`${disc.filePath}: ${err instanceof Error ? err.message : String(err)}`);
				const errors = summary(disc.source).errors;
				const faultClass = faultClassOf(err);
				errors[faultClass] = (errors[faultClass] ?? 0) + 1;
			}
		}
	}

	// Child-run artifact metadata, beside the sessions it belongs to. Ingested in
	// the same pass — and under the same project scope — so one `/prospect-sync`
	// fills everything the analyzers read, and a spawn-level child failure is in
	// the index by the time anyone looks for it. Each adapter that owns an
	// artifacts root contributes its own; a harness filter that drops the owning
	// adapter drops its artifacts with it.
	for (const adapter of active) {
		if (!adapter.artifactsRoot) continue;
		const artifacts = await ingestSubagentArtifacts(db, adapter.artifactsRoot, opts?.project);
		result.subagentRunsProcessed += artifacts.processed;
		result.subagentRunsSkipped += artifacts.skipped;
		result.errors.push(...artifacts.errors);
	}

	return result;
}

export { runSync as sync };
