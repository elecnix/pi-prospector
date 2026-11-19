import { type AsyncDatabase } from "../db/async-db.js";
import { insertMessageExtras, upsertSessionEvent } from "../db/extras-queries.js";
import * as v8 from "node:v8";
import { SyncFault, faultClassOf } from "./faults.js";
import { getSessionRow, upsertSession, getCursor, updateCursor, updateMessageCount, insertMessage, countMessages, upsertBackgroundTask } from "../db/queries.js";
import type { DiscoverOptions } from "./scanner.js";
import { ingestSubagentArtifacts } from "./subagent-artifacts.js";
import type { SourceSyncSummary, SyncResult } from "../types.js";
import type { ParsedSession, SessionSourceAdapter } from "./adapter.js";

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
/** A file the run starts or finishes, for a log that names the file being read. */
export interface FileEvent {
	phase: "start" | "finish";
	file: string;
	source: string;
	size: number;
}

export interface SyncOptions {
	reread?: boolean;
	/** Called as each file starts and finishes. */
	onFile?: (event: FileEvent) => void;
	/** Heap use, in bytes, past which a batched file stops with the class `heap-budget`. Default: 70% of the heap limit. */
	heapBudgetBytes?: number;
	/** Largest file a source that reads whole files may take. Default 1 GiB. */
	maxWholeFileBytes?: number;
}

const MAX_WHOLE_FILE_BYTES = 1024 * 1024 * 1024;

function heapUsed(): number {
	return v8.getHeapStatistics().used_heap_size;
}

function heapBudget(): number {
	return Math.floor(v8.getHeapStatistics().heap_size_limit * 0.7);
}

async function* singleBatch(read: Promise<ParsedSession>): AsyncGenerator<ParsedSession> {
	yield await read;
}

/** The session columns a read may change, not counting the cursor and the counts that every read moves. */
const SESSION_FIELDS = ["file_path", "project", "source", "cwd", "parent_session", "started_at", "name", "tool_inventory", "host"] as const;

export async function runSync(
	db: AsyncDatabase,
	adapters: SessionSourceAdapter[],
	opts?: DiscoverOptions & SyncOptions,
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

				// `visited` counts files examined: read or attempted, not skipped as unchanged. A file
				// that fails its read counts here and in `errors`.
				summary(disc.source).visited++;
				const sum = summary(disc.source);
				const startLine = opts?.reread ? 0 : (cursor?.last_line ?? 0);
				opts?.onFile?.({ phase: "start", file: disc.filePath, source: disc.source, size: disc.size });

				// A source that cannot read in batches holds the whole file in memory; one too large for
				// that ends as a classified error for this file, never a crash of the run.
				if (!adapter.readBatches && disc.size > (opts?.maxWholeFileBytes ?? MAX_WHOLE_FILE_BYTES)) {
					throw new SyncFault("file-too-large-for-adapter", `${disc.filePath} is ${disc.size} bytes and its source reads a whole file at once`);
				}
				const batches: AsyncGenerator<ParsedSession> = adapter.readBatches ? adapter.readBatches(disc, startLine) : singleBatch(adapter.read(disc, startLine));

				// The file is imported batch by batch, each batch in its own transaction that also
				// advances the cursor. A failure partway therefore keeps the batches already written and
				// the cursor at the end of the last one, and the next sync resumes from there. The file's
				// `last_modified` moves only with the final batch, so an unfinished file is read again.
				let existingBefore: Record<string, unknown> | undefined;
				let sessionId = "";
				let first = true;
				let rebuiltFile = false;
				let inserted = 0;
				let extrasAdded = 0;
				let eventsAdded = 0;
				let forks = 0;
				const budget = opts?.heapBudgetBytes ?? heapBudget();
				for await (const parsed of batches) {
					if (first) {
						sessionId = parsed.session.id;
						existingBefore = await getSessionRow(db, sessionId);
						rebuiltFile = Boolean(parsed.rebuilt);
					}
					const isLast = parsed.lastBatch !== false;
					// The host travels with the adapter, not with the transcript: a mirrored tree keeps
					// the host name of the machine that wrote it, and a local root gets this machine.
					if (adapter.host) parsed.session.host = adapter.host;
					// Only the final batch stamps the file as read. Before that the stamp is 0, even for a file
					// already indexed: an interrupted re-read must not leave it looking current.
					parsed.session.last_modified = isLast ? disc.mtime : 0;
					const keepOnly = rebuiltFile && existingBefore !== undefined;
					const write = db.transaction(async () => {
						// A rebuild an export wrote is never a source of session fields, extras, events or a
						// cursor. Messages it holds that the index lacks still insert, and a session the index
						// has never seen is created from it so it is not lost.
						if (!keepOnly) await upsertSession(db, parsed.session);
						for (const m of parsed.messages) {
							if (await insertMessage(db, m)) inserted++;
						}
						if (keepOnly) {
							// The count is derived from the stored rows, not a field taken from the rebuild.
							await updateMessageCount(db, sessionId, await countMessages(db, sessionId));
							return;
						}
						// `rebuilt` belongs to the whole file, so the first batch decides it for every batch.
						if (!rebuiltFile) {
							for (const x of parsed.extras ?? []) if (await insertMessageExtras(db, x, sessionId)) extrasAdded++;
							for (const ev of parsed.events ?? []) if (await upsertSessionEvent(db, ev)) eventsAdded++;
						}
						// A backgrounded call's completion record, when the source has one. Same transaction
						// as the messages: the completion is a fact about a call in this session.
						for (const t of parsed.backgroundTasks ?? []) await upsertBackgroundTask(db, t);
						await updateCursor(db, sessionId, parsed.processedCount, parsed.session.last_modified);
						await updateMessageCount(db, sessionId, await countMessages(db, sessionId));
					});
					await write();
					forks += parsed.forksResolved;
					first = false;
					// Nothing of a batch is kept: its arrays go out of scope here. A file that would still
					// outgrow the heap stops with a classified error; what it wrote is committed.
					if (!isLast && heapUsed() > budget) {
						throw new SyncFault("heap-budget", `${disc.filePath}: the heap passed its budget after ${parsed.processedCount} lines; the next sync resumes there`);
					}
				}
				const now = sessionId ? await getSessionRow(db, sessionId) : undefined;
				opts?.onFile?.({ phase: "finish", file: disc.filePath, source: disc.source, size: disc.size });

				sum.messagesAdded += inserted;
				result.messagesInserted += inserted;
				if (rebuiltFile && existingBefore) {
					sum.rebuiltSkipped++;
					continue;
				}
				sum.extrasAdded += extrasAdded;
				sum.eventsAdded += eventsAdded;
				if (!existingBefore) sum.sessionsAdded++;
				else if (now && SESSION_FIELDS.some((k) => existingBefore![k] !== now[k])) sum.sessionFieldsChanged++;
				result.sessionsProcessed++;
				result.forksResolved += forks;
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
