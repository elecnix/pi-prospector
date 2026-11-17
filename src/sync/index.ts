import { type AsyncDatabase } from "../db/async-db.js";
import { upsertSession, getCursor, updateCursor, updateMessageCount, insertMessage, countMessages, upsertBackgroundTask } from "../db/queries.js";
import type { DiscoverOptions } from "./scanner.js";
import { getRawProgress, getRawState, storeRawCapture } from "../db/raw-queries.js";
import { getCaptureRaw } from "../config.js";
import { ingestSubagentArtifacts } from "./subagent-artifacts.js";
import type { SyncResult } from "../types.js";
import type { SessionSourceAdapter } from "./adapter.js";
import type { RawCapture } from "./raw-capture.js";
import type { DiscoveredSession } from "../types.js";

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
	opts?: DiscoverOptions & { captureRaw?: boolean },
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

	// Lossless capture of each session file's bytes (#400). Failing to capture never
	// blocks indexing: the rows a sync writes are the same with or without it.
	const captureRaw = opts?.captureRaw ?? getCaptureRaw();
	const rawProgress = captureRaw ? await getRawProgress(db) : new Map<string, { id: string; bytes: number }>();
	const tryCapture = async (adapter: SessionSourceAdapter, disc: DiscoveredSession, sessionId: string): Promise<RawCapture | null> => {
		if (!captureRaw || !adapter.captureRaw) return null;
		try {
			const capture = await adapter.captureRaw(disc, await getRawState(db, sessionId));
			if (capture.conflict) {
				result.errors.push(`${disc.filePath}: raw capture skipped, ${capture.conflict}; the stored copy is kept`);
				return null;
			}
			return capture.chunk || capture.files.length > 0 ? capture : null;
		} catch (err) {
			result.errors.push(`${disc.filePath}: raw capture failed: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	};
	const noteCapture = (capture: RawCapture | null): void => {
		if (!capture) return;
		if (capture.chunk) {
			result.rawSessionsCaptured = (result.rawSessionsCaptured ?? 0) + 1;
			result.rawBytesStored = (result.rawBytesStored ?? 0) + capture.chunk.data.length;
		}
	};

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
					// A session indexed before capture existed is filled in once, without
					// re-parsing it or touching a row the sync wrote.
					const known = rawProgress.get(disc.filePath);
					if (captureRaw && adapter.captureRaw && known && known.bytes < disc.size) {
						const capture = await tryCapture(adapter, disc, known.id);
						if (capture) {
							await db.transaction(async () => storeRawCapture(db, capture))();
							noteCapture(capture);
						}
					}
					continue;
				}

				const parsed = await adapter.read(disc, cursor?.last_line ?? 0);
				const rawCapture = await tryCapture(adapter, disc, parsed.session.id);

				// Every DB write for this session commits as one unit. The insert
				// loop, the cursor advance and the message count are deliberately
				// inside the same transaction: if anything here fails partway,
				// SQLite rolls the whole session back atomically — no partial rows
				// *and* no advanced `last_line` — so a resync reprocesses the file
				// from the old cursor instead of skipping rows that were never
				// committed (issue #59).
				const syncSession = db.transaction(async () => {
					// The host travels with the adapter, not with the transcript: a mirrored tree keeps
					// the host name of the machine that wrote it, and a local root gets this machine.
					if (adapter.host) parsed.session.host = adapter.host;
					await upsertSession(db, parsed.session);
					for (const m of parsed.messages) {
						await insertMessage(db, m);
					}
					// A backgrounded call's completion record, when the source has one.
					// Same transaction as the messages: the completion is a fact
					// about a call in this session, so it lands with it or not at all.
					for (const t of parsed.backgroundTasks ?? []) {
						await upsertBackgroundTask(db, t);
					}
					if (rawCapture) await storeRawCapture(db, rawCapture);
					await updateCursor(db, parsed.session.id, parsed.processedCount, parsed.processedTimestamp);
					const total = await countMessages(db, parsed.session.id);
					await updateMessageCount(db, parsed.session.id, total);
				});
				await syncSession();
				noteCapture(rawCapture);

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
