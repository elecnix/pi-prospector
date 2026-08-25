import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { type AsyncDatabase, openAsyncDatabase } from "../../src/db/async-db.js";
import { migrate } from "../../src/db/schema.js";

export const FIXTURES = path.resolve(import.meta.dirname, "..", "fixtures");

/**
 * The Claude sessions root to pass when a test has no Claude fixtures of its own.
 *
 * `discoverSessions`/`runSync` require both roots precisely so a test cannot fall
 * back to the developer's real `~/.claude/projects`. Naming the absent directory
 * makes that intent explicit at each call site, rather than leaving a bare
 * `"/nonexistent"` to be misread as an accident.
 */
export const NO_CLAUDE_DIR = path.join(os.tmpdir(), "prospect-tests-no-claude-sessions");

export interface TempDb {
	db: AsyncDatabase;
	close: () => Promise<void>;
}

/** A migrated SQLite database backed by an async worker + unique temp file, with cleanup. */
export function tempDb(dbPath = path.join(os.tmpdir(), `prospect-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)): Promise<TempDb> {
	const db = openAsyncDatabase(dbPath);
	return migrate(db).then(() => ({
		db,
		close: async () => {
			await db.close();
			for (const suffix of ["", "-wal", "-shm"]) {
				try {
					fs.unlinkSync(dbPath + suffix);
				} catch {
					/* ignore */
				}
			}
		},
	}));
}

/** Insert a minimal session row so foreign keys on messages/proposals are satisfied. */
export async function insertSession(db: AsyncDatabase, id: string, filePath = `/tmp/${id}.jsonl`, cwd = "", source = "pi"): Promise<void> {
	await db.prepare(
		"INSERT INTO sessions (id, file_path, project, source, cwd, started_at, last_line, last_modified, message_count, branch_count) " +
			"VALUES (?, ?, '', ?, ?, ?, 0, 0, 0, 0)",
	).run(id, filePath, source, cwd, new Date().toISOString());
}

let messageSeq = 0;

export interface TestMessage {
	role: string;
	text?: string;
	thinking?: string;
	toolCalls?: Array<{ id?: string; name: string; arguments?: Record<string, unknown> }>;
	toolResults?: Array<{ toolCallId?: string; toolName: string; isError: boolean; textLength: number }>;
	id?: string;
	/** The serving model for an assistant message. */
	model?: string | null;
	/** The billed dollar cost of an assistant message. */
	costUsd?: number | null;
	/** How the assistant generation ended, verbatim from the host, or null. */
	stopReason?: string | null;
	/** Why the generation failed, verbatim from the host, or null when it did not. */
	errorMessage?: string | null;
}

/** Insert messages for a session in order, returning the inserted ids. */
/** Insert messages for a session in order, returning the inserted ids. */
export async function insertMessages(db: AsyncDatabase, sessionId: string, messages: TestMessage[]): Promise<string[]> {
	const stmt = db.prepare(
		"INSERT INTO messages (id, session_id, source, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, model, cost_usd, stop_reason, error_message) " +
			"VALUES (?, ?, 'pi', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	const ids: string[] = [];
	let parent: string | null = null;
	for (const m of messages) {
		const id = m.id ?? `msg-${sessionId}-${messageSeq++}`;
		await stmt.run(
			id,
			sessionId,
			parent,
			new Date(1_700_000_000_000 + messageSeq * 1000).toISOString(),
			m.role,
			m.text ?? null,
			m.thinking ?? null,
			m.toolCalls ? JSON.stringify(m.toolCalls) : null,
			m.toolResults ? JSON.stringify(m.toolResults) : null,
			m.model ?? null,
			m.costUsd ?? null,
			m.stopReason ?? null,
			m.errorMessage ?? null,
		);
		ids.push(id);
		parent = id;
	}
	return ids;
}

/** Insert a v2 proposal directly (bypassing materialisation), for query tests. */
/** Insert a v2 proposal directly (bypassing materialisation), for query tests. */
export async function insertProposalRow(
	db: AsyncDatabase,
	p: {
		id: string;
		sessionId: string;
		targetType?: string;
		targetPath?: string;
		title: string;
		severity?: string;
		summary?: string;
		status?: string;
		inputKey?: string;
	},
): Promise<void> {
	const now = new Date().toISOString();
	await db.prepare(
		"INSERT INTO proposals (id, created_at, updated_at, session_id, source_node_id, analyzer_id, target_type, target_path, title, severity, summary, detail, evidence, confidence, status, input_key) " +
			"VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)",
	).run(
		p.id,
		now,
		now,
		p.sessionId,
		p.targetType ?? "config",
		p.targetPath ?? null,
		p.title,
		p.severity ?? "suggestion",
		p.summary ?? p.title,
		p.status ?? "open",
		p.inputKey ?? `ik-${p.id}`,
	);
}
