import { type AsyncDatabase } from "../db/async-db.js";
import { upsertSession, getCursor, updateCursor, updateMessageCount, insertMessage, countMessages } from "../db/queries.js";
import type { DiscoverOptions } from "./scanner.js";
import { ingestSubagentArtifacts } from "./subagent-artifacts.js";
import type { SyncResult } from "../types.js";
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
export async function runSync(
	db: AsyncDatabase,
	adapters: SessionSourceAdapter[],
	opts?: DiscoverOptions,
): Promise<SyncResult> {
	const result: SyncResult = {
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

	for (const adapter of active) {
		for (const disc of await adapter.discover()) {
			try {
				if (claimed.has(disc.filePath)) continue;
				if (opts?.project && disc.project !== opts.project) continue;
				claimed.add(disc.filePath);

				const cursor = await getCursor(db, disc.filePath);

				// Skip unchanged files
				if (cursor && cursor.last_modified >= disc.mtime) {
					result.sessionsSkipped++;
					continue;
				}

				const parsed = await adapter.read(disc, cursor?.last_line ?? 0);

				// Every DB write for this session commits as one unit. The insert
				// loop, the cursor advance and the message count are deliberately
				// inside the same transaction: if anything here fails partway,
				// SQLite rolls the whole session back atomically — no partial rows
				// *and* no advanced `last_line` — so a resync reprocesses the file
				// from the old cursor instead of skipping rows that were never
				// committed (issue #59).
				const syncSession = db.transaction(async () => {
					await upsertSession(db, parsed.session);
					for (const m of parsed.messages) {
						await insertMessage(db, m);
					}
					await updateCursor(db, parsed.session.id, parsed.processedCount, parsed.processedTimestamp);
					const total = await countMessages(db, parsed.session.id);
					await updateMessageCount(db, parsed.session.id, total);
				});
				await syncSession();

				result.sessionsProcessed++;
				result.messagesInserted += parsed.messages.length;
				result.forksResolved += parsed.forksResolved;
			} catch (err) {
				result.errors.push(`${disc.filePath}: ${err instanceof Error ? err.message : String(err)}`);
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
