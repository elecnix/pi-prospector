import Database from "better-sqlite3";
import type {
	Proposal,
	ProposalStatus,
	Stats,
	ProposalDecision,
	DecisionVerdict,
	DecisionDisposition,
} from "../types.js";
import { getAnalysisStats } from "./analysis-queries.js";
import { uuidv7 } from "../analyze/input-hash.js";

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

/** Optional human feedback recorded alongside an accept/reject. */
export interface DecisionInput {
	disposition?: DecisionDisposition | null;
	rationale?: string | null;
	actual_change?: string | null;
	harness_ref?: string | null;
}

/**
 * Flip an open proposal's status and append an immutable decision record keyed
 * by the proposal's content-addressed input_key. Only open proposals can be
 * decided (returns false otherwise); the decision row is the durable memory
 * that survives recompute. Status is a projection of the verdict
 * (accepted/accepted_modified -> 'applied', rejected -> 'rejected').
 */
function decideProposal(
	db: Database.Database,
	id: string,
	newStatus: ProposalStatus,
	verdict: DecisionVerdict,
	input?: DecisionInput,
): boolean {
	const row = db.prepare("SELECT input_key, status FROM proposals WHERE id = ?").get(id) as
		| { input_key: string; status: string }
		| undefined;
	if (!row || row.status !== "open") return false;
	const now = new Date().toISOString();
	const tx = db.transaction(() => {
		db.prepare("UPDATE proposals SET status = ?, updated_at = ? WHERE id = ?").run(newStatus, now, id);
		db.prepare(
			"INSERT INTO proposal_decisions " +
				"(id, proposal_input_key, decision, disposition, rationale, actual_change, harness_ref, decided_at) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			uuidv7(),
			row.input_key,
			verdict,
			input?.disposition ?? null,
			input?.rationale ?? null,
			input?.actual_change ?? null,
			input?.harness_ref ?? null,
			now,
		);
	});
	tx();
	return true;
}

export function acceptProposal(db: Database.Database, id: string, input?: DecisionInput): boolean {
	const verdict: DecisionVerdict = input?.disposition === "done_differently" ? "accepted_modified" : "accepted";
	return decideProposal(db, id, "applied", verdict, input);
}

export function rejectProposal(db: Database.Database, id: string, input?: DecisionInput): boolean {
	return decideProposal(db, id, "rejected", "rejected", input);
}

// ── Proposal decisions (append-only human feedback) ──

/** The latest (authoritative) decision for a proposal's input_key, if any. */
export function getLatestDecision(db: Database.Database, proposalInputKey: string): ProposalDecision | undefined {
	return db
		.prepare("SELECT * FROM proposal_decisions WHERE proposal_input_key = ? ORDER BY decided_at DESC, rowid DESC LIMIT 1")
		.get(proposalInputKey) as ProposalDecision | undefined;
}

/** Full decision history for one proposal, oldest first. */
export function getDecisionsForProposal(db: Database.Database, proposalInputKey: string): ProposalDecision[] {
	return db
		.prepare("SELECT * FROM proposal_decisions WHERE proposal_input_key = ? ORDER BY decided_at ASC, rowid ASC")
		.all(proposalInputKey) as ProposalDecision[];
}

/** Every decision, newest first — the corpus the future meta-analyzer consumes. */
export function getAllDecisions(db: Database.Database): ProposalDecision[] {
	return db.prepare("SELECT * FROM proposal_decisions ORDER BY decided_at DESC, rowid DESC").all() as ProposalDecision[];
}

// ── Proposal validation (issue #6) ──

/** Open proposals for a session, in stable order — the input to proposal-validate. */
export function listOpenProposalsForSession(db: Database.Database, sessionId: string): Proposal[] {
	return db
		.prepare("SELECT * FROM proposals WHERE session_id = ? AND status = 'open' ORDER BY created_at ASC, rowid ASC")
		.all(sessionId) as Proposal[];
}

/** Distinct session ids that currently have at least one open proposal to validate. */
export function listSessionIdsWithOpenProposals(db: Database.Database, limit?: number): string[] {
	const rows = db
		.prepare("SELECT DISTINCT session_id FROM proposals WHERE status = 'open' ORDER BY session_id")
		.all() as Array<{ session_id: string }>;
	const ids = rows.map((r) => r.session_id);
	return typeof limit === "number" ? ids.slice(0, limit) : ids;
}

/** Count open proposals grouped by validation status, for a run summary. */
export function countOpenProposalsByValidationStatus(db: Database.Database): Record<string, number> {
	const rows = db
		.prepare("SELECT validation_status AS s, COUNT(*) AS c FROM proposals WHERE status = 'open' GROUP BY validation_status")
		.all() as Array<{ s: string; c: number }>;
	const out: Record<string, number> = {};
	for (const r of rows) out[r.s] = r.c;
	return out;
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