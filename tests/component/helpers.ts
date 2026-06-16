import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/schema.js";

export const FIXTURES = path.resolve(import.meta.dirname, "..", "fixtures");

export interface TempDb {
	db: Database.Database;
	close: () => void;
}

/** A migrated SQLite database backed by a unique temp file, with cleanup. */
export function tempDb(): TempDb {
	const dbPath = path.join(os.tmpdir(), `prospect-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
	const db = new Database(dbPath);
	migrate(db);
	return {
		db,
		close: () => {
			db.close();
			for (const suffix of ["", "-wal", "-shm"]) {
				try {
					fs.unlinkSync(dbPath + suffix);
				} catch {
					/* ignore */
				}
			}
		},
	};
}

/** Insert a minimal session row so foreign keys on messages/proposals are satisfied. */
export function insertSession(db: Database.Database, id: string, filePath = `/tmp/${id}.jsonl`): void {
	db.prepare(
		"INSERT INTO sessions (id, file_path, project, cwd, started_at, last_line, last_modified, message_count, branch_count) " +
			"VALUES (?, ?, '', '', ?, 0, 0, 0, 0)",
	).run(id, filePath, new Date().toISOString());
}

let messageSeq = 0;

export interface TestMessage {
	role: string;
	text?: string;
	thinking?: string;
	toolCalls?: Array<{ name: string }>;
	toolResults?: Array<{ toolName: string; isError: boolean; textLength: number }>;
	id?: string;
}

/** Insert messages for a session in order, returning the inserted ids. */
export function insertMessages(db: Database.Database, sessionId: string, messages: TestMessage[]): string[] {
	const stmt = db.prepare(
		"INSERT INTO messages (id, session_id, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	const ids: string[] = [];
	let parent: string | null = null;
	for (const m of messages) {
		const id = m.id ?? `msg-${sessionId}-${messageSeq++}`;
		stmt.run(
			id,
			sessionId,
			parent,
			new Date(1_700_000_000_000 + messageSeq * 1000).toISOString(),
			m.role,
			m.text ?? null,
			m.thinking ?? null,
			m.toolCalls ? JSON.stringify(m.toolCalls) : null,
			m.toolResults ? JSON.stringify(m.toolResults) : null,
		);
		ids.push(id);
		parent = id;
	}
	return ids;
}

/** Insert a v2 proposal directly (bypassing materialisation), for query tests. */
export function insertProposalRow(
	db: Database.Database,
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
): void {
	const now = new Date().toISOString();
	db.prepare(
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
