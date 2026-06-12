import Database from "better-sqlite3";
import type { Proposal, ProposalStatus, Stats } from "../types.js";
import { getAnalysisStats } from "./analysis-queries.js";

// ── Sessions ──

export interface SessionInsert {
	id: string;
	file_path: string;
	project: string;
	cwd: string;
	parent_session: string | null;
	started_at: string;
	last_line: number;
	last_modified: number;
	analyzed_at: string | null;
	message_count: number;
	branch_count: number;
}

export function upsertSession(db: Database.Database, s: SessionInsert): void {
	db.prepare(`
		INSERT INTO sessions (id, file_path, project, cwd, parent_session, started_at, last_line, last_modified, analyzed_at, message_count, branch_count)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			file_path=excluded.file_path, project=excluded.project, cwd=excluded.cwd,
			parent_session=excluded.parent_session, last_line=excluded.last_line,
			last_modified=excluded.last_modified, message_count=excluded.message_count,
			branch_count=excluded.branch_count
	`).run(s.id, s.file_path, s.project, s.cwd, s.parent_session, s.started_at, s.last_line, s.last_modified, s.analyzed_at, s.message_count, s.branch_count);
}

export function getCursor(db: Database.Database, filePath: string): { last_line: number; last_modified: number } | undefined {
	return db.prepare("SELECT last_line, last_modified FROM sessions WHERE file_path = ?").get(filePath) as { last_line: number; last_modified: number } | undefined;
}

export function updateCursor(db: Database.Database, sessionId: string, lastLine: number, lastModified: number): void {
	db.prepare("UPDATE sessions SET last_line = ?, last_modified = ? WHERE id = ?").run(lastLine, lastModified, sessionId);
}

export function updateMessageCount(db: Database.Database, sessionId: string, count: number): void {
	db.prepare("UPDATE sessions SET message_count = ? WHERE id = ?").run(count, sessionId);
}

export function markAnalyzed(db: Database.Database, sessionId: string): void {
	db.prepare("UPDATE sessions SET analyzed_at = ? WHERE id = ?").run(new Date().toISOString(), sessionId);
}

export function getUnanalyzedSessions(db: Database.Database, limit?: number): Array<{ id: string; file_path: string; started_at: string }> {
	const sql = limit
		? "SELECT id, file_path, started_at FROM sessions WHERE analyzed_at IS NULL ORDER BY started_at ASC LIMIT ?"
		: "SELECT id, file_path, started_at FROM sessions WHERE analyzed_at IS NULL ORDER BY started_at ASC";
	return (limit ? db.prepare(sql).all(limit) : db.prepare(sql).all()) as Array<{ id: string; file_path: string; started_at: string }>;
}

export function getAllSessions(db: Database.Database, limit?: number): Array<{ id: string; file_path: string; started_at: string }> {
	const sql = limit
		? "SELECT id, file_path, started_at FROM sessions ORDER BY started_at ASC LIMIT ?"
		: "SELECT id, file_path, started_at FROM sessions ORDER BY started_at ASC";
	return (limit ? db.prepare(sql).all(limit) : db.prepare(sql).all()) as Array<{ id: string; file_path: string; started_at: string }>;
}

export interface SessionLabel {
	id: string;
	project: string;
	cwd: string;
	message_count: number;
}

/** Lightweight labels (project/cwd/message_count) for every session, for display. */
export function getSessionLabels(db: Database.Database): SessionLabel[] {
	return db.prepare("SELECT id, project, cwd, message_count FROM sessions").all() as SessionLabel[];
}

// ── Messages ──

export interface MessageInsert {
	id: string;
	session_id: string;
	parent_id: string | null;
	timestamp: string | null;
	role: string;
	content_text: string | null;
	content_thinking: string | null;
	tool_calls: string | null;
	tool_results: string | null;
}

export function insertMessage(db: Database.Database, m: MessageInsert): void {
	db.prepare(`
		INSERT OR IGNORE INTO messages (id, session_id, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, content_hash)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(m.id, m.session_id, m.parent_id, m.timestamp, m.role, m.content_text, m.content_thinking, m.tool_calls, m.tool_results, null);
}

export function countMessages(db: Database.Database, sessionId: string): number {
	return (db.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ?").get(sessionId) as { c: number }).c;
}

export function getSessionMessages(db: Database.Database, sessionId: string): Array<{ role: string; content_text: string | null; content_thinking: string | null; tool_calls: string | null; timestamp: string | null }> {
	return db.prepare("SELECT role, content_text, content_thinking, tool_calls, timestamp FROM messages WHERE session_id = ? ORDER BY rowid ASC").all(sessionId) as any[];
}

// ── Proposals (v2) ──

export function listProposals(db: Database.Database, status?: string): Proposal[] {
	if (status) return db.prepare("SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC").all(status) as Proposal[];
	return db.prepare("SELECT * FROM proposals ORDER BY created_at DESC").all() as Proposal[];
}

export function getProposal(db: Database.Database, id: string): Proposal | undefined {
	return db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as Proposal | undefined;
}

export function acceptProposal(db: Database.Database, id: string): boolean {
	return db
		.prepare("UPDATE proposals SET status = 'applied', updated_at = ? WHERE id = ? AND status = 'open'")
		.run(new Date().toISOString(), id).changes > 0;
}

export function rejectProposal(db: Database.Database, id: string): boolean {
	return db
		.prepare("UPDATE proposals SET status = 'rejected', updated_at = ? WHERE id = ? AND status = 'open'")
		.run(new Date().toISOString(), id).changes > 0;
}

// ── Stats ──

export function getStats(db: Database.Database): Stats {
	const totalSessions = (db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number }).c;
	const totalMessages = (db.prepare("SELECT COUNT(*) as c FROM messages WHERE role IN ('user','assistant')").get() as { c: number }).c;
	const totalToolResults = (db.prepare("SELECT COUNT(*) as c FROM messages WHERE role = 'toolResult'").get() as { c: number }).c;
	const sessionsAnalyzed = (db.prepare("SELECT COUNT(*) as c FROM sessions WHERE analyzed_at IS NOT NULL").get() as { c: number }).c;

	const statusRows = db.prepare("SELECT status, COUNT(*) as c FROM proposals GROUP BY status").all() as Array<{ status: string; c: number }>;
	const proposalsByStatus: Record<ProposalStatus, number> = { open: 0, applied: 0, rejected: 0, duplicate: 0 };
	for (const r of statusRows) {
		if (r.status === "open" || r.status === "applied" || r.status === "rejected" || r.status === "duplicate") {
			proposalsByStatus[r.status] = r.c;
		}
	}

	return {
		totalSessions,
		totalMessages,
		totalToolResults,
		sessionsAnalyzed,
		proposalsByStatus,
		analysis: getAnalysisStats(db),
	};
}