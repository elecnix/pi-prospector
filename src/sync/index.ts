import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { migrate } from "../db/schema.js";
import { upsertSession, getCursor, updateCursor, updateMessageCount, insertMessage, countMessages } from "../db/queries.js";
import { discoverSessions, type DiscoverOptions } from "./scanner.js";
import { parseLine, parseClaudeSessionMeta, buildClaudeToolNameMap } from "./parser.js";
import { resolveFork } from "./forks.js";
import type { SyncResult, SessionSource } from "../types.js";

/**
 * Ingest every session under the two given roots.
 *
 * Both roots are required: see `discoverSessions` for why the Claude directory is
 * a parameter rather than an ambient lookup.
 *
 * An optional `opts` scope narrows the ingest to a project or harness — the
 * fresh-install escape hatch that keeps a one-project sync from paying for
 * every session on disk.
 */
export function runSync(
	db: Database.Database,
	sessionsDir: string,
	claudeSessionsDir: string,
	opts?: DiscoverOptions,
): SyncResult {
	const discovered = discoverSessions(sessionsDir, claudeSessionsDir, opts);
	const result: SyncResult = { sessionsProcessed: 0, sessionsSkipped: 0, messagesInserted: 0, forksResolved: 0, errors: [] };

	for (const disc of discovered) {
		try {
			const cursor = getCursor(db, disc.filePath);

			// Skip unchanged files
			if (cursor && cursor.last_modified >= disc.mtime) {
				result.sessionsSkipped++;
				continue;
			}

			const content = fs.readFileSync(disc.filePath, "utf-8");
			const lines = content.split("\n");

			if (disc.source === "claude") {
				syncClaudeSession(db, disc, lines, cursor, result);
			} else {
				syncPiSession(db, disc, lines, cursor, sessionsDir, result);
			}
		} catch (err) {
			result.errors.push(`${disc.filePath}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return result;
}

function syncPiSession(
	db: Database.Database,
	disc: { filePath: string; project: string; mtime: number; source: SessionSource },
	lines: string[],
	cursor: { last_line: number; last_modified: number } | undefined,
	sessionsDir: string,
	result: SyncResult,
): void {
	// Parse session header (must be first non-empty line)
	let sessionId = "";
	let parentSession: string | null = null;
	let cwd = "";
	let startedAt = "";

	for (const line of lines) {
		if (!line.trim()) continue;
		const parsed = parseLine(line);
		if (parsed && parsed.kind === "session") {
			sessionId = parsed.header.id;
			parentSession = parsed.header.parentSession ?? null;
			cwd = parsed.header.cwd ?? "";
			startedAt = parsed.header.timestamp ?? "";
			break;
		}
		break; // First non-empty line wasn't a header — malformed
	}

	if (!sessionId) {
		result.errors.push(`No session header: ${disc.filePath}`);
		return;
	}

	// Resolve fork
	let branchCount = 0;
	if (parentSession) {
		const forkInfo = resolveFork(parentSession, sessionsDir);
		if (forkInfo) {
			branchCount = 1;
			result.forksResolved++;
		}
	}

	// Every DB write for this session commits as one unit. The insert loop, the
	// cursor advance and the message count are deliberately inside the same
	// transaction: if anything here fails partway, SQLite rolls the whole session
	// back atomically — no partial rows *and* no advanced `last_line` — so a
	// resync reprocesses the file from the old cursor instead of skipping rows
	// that were never committed (issue #59).
	const resumeLine = cursor?.last_line ?? 0;
	let msgCount = 0;

	const syncSession = db.transaction(() => {
		// Upsert session
		upsertSession(db, {
			id: sessionId,
			file_path: disc.filePath,
			project: disc.project,
			source: disc.source,
			cwd,
			parent_session: parentSession,
			started_at: startedAt,
			last_line: cursor?.last_line ?? 0,
			last_modified: disc.mtime,
			analyzed_at: null,
			message_count: 0,
			branch_count: branchCount,
		});

		// Parse messages from resume point
		for (let i = resumeLine; i < lines.length; i++) {
			const line = lines[i]?.trim();
			if (!line) continue;

			const parsed = parseLine(line);
			if (!parsed || parsed.kind === "session") continue;

			const entry = parsed.entry;
			insertMessage(db, {
				id: entry.id,
				session_id: sessionId,
				source: disc.source,
				parent_id: entry.parentId,
				timestamp: entry.timestamp,
				role: entry.role,
				content_text: entry.text,
				content_thinking: entry.thinking,
				tool_calls: entry.tool_calls ? JSON.stringify(entry.tool_calls) : null,
				tool_results: entry.tool_results ? JSON.stringify(entry.tool_results) : null,
				usage: entry.usage ? JSON.stringify(entry.usage) : null,
				model: entry.model,
				cost_usd: entry.costUsd,
				provider_message_id: entry.providerMessageId,
				stop_reason: entry.stopReason,
				error_message: entry.errorMessage,
			});
			msgCount++;
		}

		// Update cursor and message count
		updateCursor(db, sessionId, lines.length, disc.mtime);
		const total = countMessages(db, sessionId);
		updateMessageCount(db, sessionId, total);
	});
	syncSession();

	result.sessionsProcessed++;
	result.messagesInserted += msgCount;
}

function syncClaudeSession(
	db: Database.Database,
	disc: { filePath: string; project: string; mtime: number; source: SessionSource },
	lines: string[],
	cursor: { last_line: number; last_modified: number } | undefined,
	result: SyncResult,
): void {
	// Derive session ID from file name (UUID)
	const sessionId = path.basename(disc.filePath, ".jsonl");

	const meta = parseClaudeSessionMeta(lines);
	const startedAt = meta?.timestamp ?? null;
	const cwd = (meta?.cwd ?? disc.project) || "";

	// Claude tool_result blocks carry only a tool_use_id; resolve the tool name
	// from the matching tool_use in the preceding assistant message (issue #30).
	// Built from ALL lines (not just the resume point) so a tool_use/tool_result
	// pair that straddles the cursor still resolves on an incremental sync.
	const toolNamesById = buildClaudeToolNameMap(lines);

	// Every DB write for this session commits as one unit, with the cursor
	// advance inside the same transaction (see syncPiSession, issue #59).
	const resumeLine = cursor?.last_line ?? 0;
	let msgCount = 0;

	const syncSession = db.transaction(() => {
		// Upsert session
		upsertSession(db, {
			id: sessionId,
			file_path: disc.filePath,
			project: disc.project,
			source: disc.source,
			cwd,
			parent_session: null,
			started_at: startedAt ?? "",
			last_line: cursor?.last_line ?? 0,
			last_modified: disc.mtime,
			analyzed_at: null,
			message_count: 0,
			branch_count: 0,
		});

		// Parse messages from resume point
		for (let i = resumeLine; i < lines.length; i++) {
			const line = lines[i]?.trim();
			if (!line) continue;

			const parsed = parseLine(line, "claude", toolNamesById);
			if (!parsed || parsed.kind !== "message") continue;

			const entry = parsed.entry;
			insertMessage(db, {
				id: entry.id,
				session_id: sessionId,
				source: disc.source,
				parent_id: entry.parentId,
				timestamp: entry.timestamp,
				role: entry.role,
				content_text: entry.text,
				content_thinking: entry.thinking,
				tool_calls: entry.tool_calls ? JSON.stringify(entry.tool_calls) : null,
				tool_results: entry.tool_results ? JSON.stringify(entry.tool_results) : null,
				usage: entry.usage ? JSON.stringify(entry.usage) : null,
				model: entry.model,
				cost_usd: entry.costUsd,
				provider_message_id: entry.providerMessageId,
				stop_reason: entry.stopReason,
				error_message: entry.errorMessage,
			});
			msgCount++;
		}

		// Update cursor and message count
		updateCursor(db, sessionId, lines.length, disc.mtime);
		const total = countMessages(db, sessionId);
		updateMessageCount(db, sessionId, total);
	});
	syncSession();

	result.sessionsProcessed++;
	result.messagesInserted += msgCount;
}

export { runSync as sync };
