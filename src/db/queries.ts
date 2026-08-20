import Database from "better-sqlite3";
import { prep } from "./prepared.js";
import {
	ASSERTION_SUBJECT_KINDS,
	REMEDIATION_VERDICT,
	upsertAssertion,
	getProposalAssertions,
	getProposalAssertionsForKey,
	getProposalAssertionsByRemediation,
	getRemediationAssertion,
	type AssertionRow,
} from "./assertions.js";
import type {
	Proposal,
	ProposalStatus,
	Stats,
	ProposalDecision,
	DecisionVerdict,
	DecisionDisposition,
	Remediation,
} from "../types.js";
import { getAnalysisStats } from "./analysis-queries.js";
import { uuidv7 } from "../analyze/input-hash.js";
import type { TokenStats, SourceTokenStats } from "../types.js";

// ── Sessions ──

export interface SessionInsert {
	id: string;
	file_path: string;
	project: string;
	source: string;
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
	prep(db, `
		INSERT INTO sessions (id, file_path, project, source, cwd, parent_session, started_at, last_line, last_modified, analyzed_at, message_count, branch_count)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			file_path=excluded.file_path, project=excluded.project, source=excluded.source, cwd=excluded.cwd,
			parent_session=excluded.parent_session, last_line=excluded.last_line,
			last_modified=excluded.last_modified, message_count=excluded.message_count,
			branch_count=excluded.branch_count
	`).run(s.id, s.file_path, s.project, s.source, s.cwd, s.parent_session, s.started_at, s.last_line, s.last_modified, s.analyzed_at, s.message_count, s.branch_count);
}

export function getCursor(db: Database.Database, filePath: string): { last_line: number; last_modified: number } | undefined {
	return prep(db, "SELECT last_line, last_modified FROM sessions WHERE file_path = ?").get(filePath) as { last_line: number; last_modified: number } | undefined;
}

export function updateCursor(db: Database.Database, sessionId: string, lastLine: number, lastModified: number): void {
	prep(db, "UPDATE sessions SET last_line = ?, last_modified = ? WHERE id = ?").run(lastLine, lastModified, sessionId);
}

export function updateMessageCount(db: Database.Database, sessionId: string, count: number): void {
	prep(db, "UPDATE sessions SET message_count = ? WHERE id = ?").run(count, sessionId);
}

export function markAnalyzed(db: Database.Database, sessionId: string): void {
	prep(db, "UPDATE sessions SET analyzed_at = ? WHERE id = ?").run(new Date().toISOString(), sessionId);
}

export function getUnanalyzedSessions(db: Database.Database, limit?: number): Array<{ id: string; file_path: string; started_at: string }> {
	const sql = limit
		? "SELECT id, file_path, started_at FROM sessions WHERE analyzed_at IS NULL ORDER BY started_at ASC LIMIT ?"
		: "SELECT id, file_path, started_at FROM sessions WHERE analyzed_at IS NULL ORDER BY started_at ASC";
	return (limit ? prep(db, sql).all(limit) : prep(db, sql).all()) as Array<{ id: string; file_path: string; started_at: string }>;
}

export function getAllSessions(db: Database.Database, limit?: number): Array<{ id: string; file_path: string; started_at: string }> {
	const sql = limit
		? "SELECT id, file_path, started_at FROM sessions ORDER BY started_at ASC LIMIT ?"
		: "SELECT id, file_path, started_at FROM sessions ORDER BY started_at ASC";
	return (limit ? prep(db, sql).all(limit) : prep(db, sql).all()) as Array<{ id: string; file_path: string; started_at: string }>;
}

/** Get the N most-recent sessions by started_at, useful for pilots. */
export function getRecentSessions(db: Database.Database, limit: number): Array<{ id: string; file_path: string; started_at: string }> {
	return prep(db, "SELECT id, file_path, started_at FROM sessions ORDER BY started_at DESC LIMIT ?").all(limit) as Array<{ id: string; file_path: string; started_at: string }>;
}

export interface SessionLabel {
	id: string;
	project: string;
	cwd: string;
	message_count: number;
}

/** Lightweight labels (project/cwd/message_count) for every session, for display. */
export function getSessionLabels(db: Database.Database): SessionLabel[] {
	return prep(db, "SELECT id, project, cwd, message_count FROM sessions").all() as SessionLabel[];
}

// ── Messages ──

export interface MessageInsert {
	id: string;
	session_id: string;
	source: string;
	parent_id: string | null;
	timestamp: string | null;
	role: string;
	content_text: string | null;
	content_thinking: string | null;
	tool_calls: string | null;
	tool_results: string | null;
	usage: string | null;
	model: string | null;
	cost_usd: number | null;
	/** The provider's response id — several rows may share one. See the schema note. */
	provider_message_id: string | null;
	/** How the assistant generation ended, verbatim from the host. NULL for non-assistant rows. */
	stop_reason: string | null;
	/** Why it failed, verbatim from the host. NULL unless the generation failed. */
	error_message: string | null;
}

export function insertMessage(db: Database.Database, m: MessageInsert): void {
	prep(db, `
		INSERT OR IGNORE INTO messages (id, session_id, source, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, usage, content_hash, model, cost_usd, provider_message_id, stop_reason, error_message)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(m.id, m.session_id, m.source, m.parent_id, m.timestamp, m.role, m.content_text, m.content_thinking, m.tool_calls, m.tool_results, m.usage, null, m.model, m.cost_usd, m.provider_message_id, m.stop_reason, m.error_message);
}

export function countMessages(db: Database.Database, sessionId: string): number {
	return (prep(db, "SELECT COUNT(*) as c FROM messages WHERE session_id = ?").get(sessionId) as { c: number }).c;
}

export function getSessionMessages(db: Database.Database, sessionId: string): Array<{ role: string; content_text: string | null; content_thinking: string | null; tool_calls: string | null; timestamp: string | null }> {
	return prep(db, "SELECT role, content_text, content_thinking, tool_calls, timestamp FROM messages WHERE session_id = ? ORDER BY rowid ASC").all(sessionId) as any[];
}

// ── Proposals (v2) ──

export function listProposals(db: Database.Database, status?: string, severity?: string, limit?: number, offset?: number): Proposal[] {
	const clauses: string[] = [];
	const params: (string | number)[] = [];
	if (status) {
		clauses.push("status = ?");
		params.push(status);
	}
	if (severity) {
		clauses.push("severity = ?");
		params.push(severity);
	}
	const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
	let sql = `SELECT * FROM proposals${where} ORDER BY created_at DESC`;
	if (limit !== undefined) {
		sql += ` LIMIT ?`;
		params.push(limit);
		if (offset !== undefined) {
			sql += ` OFFSET ?`;
			params.push(offset);
		}
	}
	return prep(db, sql).all(...params) as Proposal[];
}

export function getProposal(db: Database.Database, id: string): Proposal | undefined {
	return prep(db, "SELECT * FROM proposals WHERE id = ?").get(id) as Proposal | undefined;
}

/**
 * The latest decision recorded at or before T for each proposal, keyed by
 * `proposal_input_key`. The decision log is the event source that makes the
 * mutable `proposals.status` projection reconstructible at a point in time.
 */
function latestDecisionsAsOf(db: Database.Database, at: string): Map<string, ProposalDecision> {
	const rows = db
		.prepare("SELECT * FROM proposal_decisions WHERE decided_at <= ? ORDER BY decided_at ASC, rowid ASC")
		.all(at) as ProposalDecision[];
	const latest = new Map<string, ProposalDecision>();
	for (const d of rows) {
		const cur = latest.get(d.proposal_input_key);
		if (!cur || d.decided_at > cur.decided_at || (d.decided_at === cur.decided_at && d.id > cur.id)) {
			latest.set(d.proposal_input_key, d);
		}
	}
	return latest;
}

/**
 * Proposals as they existed at time `at`: only those created by then, with their
 * status derived by replaying decisions recorded up to T (latest per input_key).
 * This is the reconstructible, immutable projection of the mutable status column.
 */
export function listProposalsAsOf(db: Database.Database, at: string): Proposal[] {
	const proposals = db
		.prepare("SELECT * FROM proposals WHERE created_at <= ? ORDER BY created_at DESC")
		.all(at) as Proposal[];
	const latest = latestDecisionsAsOf(db, at);
	for (const p of proposals) {
		const d = latest.get(p.input_key);
		// A proposal starts life "open" and only transitions by a recorded decision,
		// so with no decision by T it was open at T — never fall back to the mutable
		// stored column, which may reflect a decision that happened after T.
		p.status = d ? (d.decision === "rejected" ? "rejected" : "applied") : "open";
	}
	return proposals;
}

/** Status counts for proposals as of `at` (undefined = live/current). */
function proposalStatusCountsAt(db: Database.Database, at?: string): Record<ProposalStatus, number> {
	const counts: Record<ProposalStatus, number> = { open: 0, applied: 0, rejected: 0, duplicate: 0 };
	if (at === undefined) {
		const rows = db.prepare("SELECT status, COUNT(*) AS c FROM proposals GROUP BY status").all() as Array<{
			status: string;
			c: number;
		}>
		for (const r of rows) {
			if (r.status === "open" || r.status === "applied" || r.status === "rejected" || r.status === "duplicate") {
				counts[r.status as ProposalStatus] = r.c;
			}
		}
		return counts;
	}
	for (const p of listProposalsAsOf(db, at)) {
		counts[p.status]++;
	}
	return counts;
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

/** Map a proposal assertion row back to the domain `ProposalDecision` shape. */
function assertionToDecision(a: AssertionRow): ProposalDecision {
	return {
		id: a.id,
		proposal_input_key: a.subject_key,
		decision: a.verdict as DecisionVerdict,
		disposition: a.disposition as DecisionDisposition | null,
		rationale: a.reason,
		actual_change: a.actual_change,
		harness_ref: a.harness_ref,
		remediation_id: a.remediation_id,
		decided_at: a.asserted_at,
	};
}

/** Map a remediation assertion row back to the domain `Remediation` shape. */
function assertionToRemediation(a: AssertionRow): Remediation {
	return {
		id: a.subject_key,
		description: a.reason ?? "",
		actual_change: a.actual_change,
		created_at: a.asserted_at,
	};
}

function decideProposal(
	db: Database.Database,
	id: string,
	newStatus: ProposalStatus,
	verdict: DecisionVerdict,
	input?: DecisionInput,
	remediationId?: string | null,
): boolean {
	const row = prep(db, "SELECT input_key, status FROM proposals WHERE id = ?").get(id) as
		| { input_key: string; status: string }
		| undefined;
	if (!row || row.status !== "open") return false;
	const now = new Date().toISOString();
	const tx = db.transaction(() => {
		prep(db, "UPDATE proposals SET status = ?, updated_at = ? WHERE id = ?").run(newStatus, now, id);
		// The decision is written to the legacy table (the reversible rollback)
		// AND to the assertions relation, the canonical view keyed by the
		// content-addressed proposal input_key (issue #73). Both in one transaction
		// so they never diverge; reads go through assertions. The legacy table is
		// kept, still written, until a separate change retires it.
		prep(db, 
			"INSERT INTO proposal_decisions " +
				"(id, proposal_input_key, decision, disposition, rationale, actual_change, harness_ref, remediation_id, decided_at) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			uuidv7(),
			row.input_key,
			verdict,
			input?.disposition ?? null,
			input?.rationale ?? null,
			input?.actual_change ?? null,
			input?.harness_ref ?? null,
			remediationId ?? null,
			now,
		);
		upsertAssertion(db, {
			subjectKind: ASSERTION_SUBJECT_KINDS.PROPOSAL,
			subjectKey: row.input_key,
			verdict,
			reason: input?.rationale ?? null,
			assertedAt: now,
			assertedBy: "operator",
			disposition: input?.disposition ?? null,
			actualChange: input?.actual_change ?? null,
			harnessRef: input?.harness_ref ?? null,
			remediationId: remediationId ?? null,
		});
	});
	tx();
	return true;
}

/** The verdict an accept records: done_differently means the idea was applied in a modified form. */
function acceptVerdict(input?: DecisionInput): DecisionVerdict {
	return input?.disposition === "done_differently" ? "accepted_modified" : "accepted";
}

export function acceptProposal(db: Database.Database, id: string, input?: DecisionInput): boolean {
	return decideProposal(db, id, "applied", acceptVerdict(input), input);
}

export function rejectProposal(db: Database.Database, id: string, input?: DecisionInput): boolean {
	return decideProposal(db, id, "rejected", "rejected", input);
}

// ── Bulk accept / reject ──

export interface BulkResult {
	accepted: string[];
	rejected: string[];
	skipped: string[];
}

/** Accept multiple proposals with the same decision input (no remediation row). */
export function acceptProposalsBulk(
	db: Database.Database,
	proposalIds: string[],
	input?: DecisionInput,
): BulkResult {
	const accepted: string[] = [];
	const skipped: string[] = [];
	const verdict = acceptVerdict(input);
	const tx = db.transaction(() => {
		for (const id of proposalIds) {
			if (decideProposal(db, id, "applied", verdict, input)) accepted.push(id);
			else skipped.push(id);
		}
	});
	tx();
	return { accepted, rejected: [], skipped };
}

/** Reject multiple proposals with the same decision input. */
export function rejectProposalsBulk(
	db: Database.Database,
	proposalIds: string[],
	input?: DecisionInput,
): BulkResult {
	const rejected: string[] = [];
	const skipped: string[] = [];
	const tx = db.transaction(() => {
		for (const id of proposalIds) {
			if (decideProposal(db, id, "rejected", "rejected", input)) rejected.push(id);
			else skipped.push(id);
		}
	});
	tx();
	return { accepted: [], rejected, skipped };
}

// ── Remediations (one action addressing many proposals) ──

/** The shared remediation action recorded with a batch accept. */
export interface RemediationInput {
	description: string;
	actual_change?: string | null;
}

export interface RemediateResult {
	/** Null when no proposal was accepted (no remediation row is created). */
	remediationId: string | null;
	accepted: string[];
	skipped: string[];
}

/**
 * Accept many proposals under ONE shared remediation: a single transaction
 * inserts one remediations row and appends a decision per open proposal, each
 * linked via remediation_id — instead of N accepts duplicating the same
 * rationale. Non-open or unknown ids are skipped and reported; the remediation
 * row is only created when at least one proposal is actually accepted. The
 * description doubles as the default rationale so each decision row stays
 * self-contained for the meta-analyzer corpus.
 */
export function acceptProposalsWithRemediation(
	db: Database.Database,
	proposalIds: string[],
	remediation: RemediationInput,
	input?: DecisionInput,
): RemediateResult {
	const decision: DecisionInput = {
		...input,
		rationale: input?.rationale ?? remediation.description,
		actual_change: input?.actual_change ?? remediation.actual_change ?? null,
	};
	const accepted: string[] = [];
	const skipped: string[] = [];
	let remediationId: string | null = null;
	const tx = db.transaction(() => {
		const open = new Set(
			proposalIds.filter((id) => {
				const row = prep(db, "SELECT status FROM proposals WHERE id = ?").get(id) as { status: string } | undefined;
				return row?.status === "open";
			}),
		);
		if (open.size > 0) {
			remediationId = uuidv7();
			const createdAt = new Date().toISOString();
			prep(db, "INSERT INTO remediations (id, description, actual_change, created_at) VALUES (?, ?, ?, ?)").run(
				remediationId,
				remediation.description,
				remediation.actual_change ?? null,
				createdAt,
			);
			// Also record the shared remediation as an assertion (issue #73), so the
			// disaster corpus is uniform; decisions reference it via remediation_id.
			upsertAssertion(db, {
				subjectKind: ASSERTION_SUBJECT_KINDS.REMEDIATION,
				subjectKey: remediationId,
				verdict: REMEDIATION_VERDICT,
				reason: remediation.description,
				assertedAt: createdAt,
				actualChange: remediation.actual_change ?? null,
			});
		}
		for (const id of proposalIds) {
			if (open.has(id) && decideProposal(db, id, "applied", acceptVerdict(decision), decision, remediationId)) {
				accepted.push(id);
			} else {
				skipped.push(id);
			}
		}
	});
	tx();
	return { remediationId, accepted, skipped };
}

export function getRemediation(db: Database.Database, id: string): Remediation | undefined {
	const a = getRemediationAssertion(db, id);
	return a ? assertionToRemediation(a) : undefined;
}

/** Every decision made under one remediation, oldest first. */
export function getDecisionsForRemediation(db: Database.Database, remediationId: string): ProposalDecision[] {
	return getProposalAssertionsByRemediation(db, remediationId).map(assertionToDecision);
}

// ── Proposal decisions (append-only human feedback) ──

/** The latest (authoritative) decision for a proposal's input_key, if any. */
export function getLatestDecision(db: Database.Database, proposalInputKey: string): ProposalDecision | undefined {
	const rows = getProposalAssertionsForKey(db, proposalInputKey);
	if (rows.length === 0) return undefined;
	// Oldest-first, so the latest (authoritative) decision is the last row.
	return assertionToDecision(rows[rows.length - 1]!);
}

/** Full decision history for one proposal, oldest first. */
export function getDecisionsForProposal(db: Database.Database, proposalInputKey: string): ProposalDecision[] {
	return getProposalAssertionsForKey(db, proposalInputKey).map(assertionToDecision);
}

/** Every decision, newest first — the corpus the future meta-analyzer consumes. */
export function getAllDecisions(db: Database.Database): ProposalDecision[] {
	return getProposalAssertions(db).map(assertionToDecision);
}

// ── Proposal validation (issue #6) ──

/** Open proposals for a session, in stable order — the input to proposal-validate. */
export function listOpenProposalsForSession(db: Database.Database, sessionId: string): Proposal[] {
	return prep(db, "SELECT * FROM proposals WHERE session_id = ? AND status = 'open' ORDER BY created_at ASC, rowid ASC")
		.all(sessionId) as Proposal[];
}

/** Distinct session ids that currently have at least one open proposal to validate. */
export function listSessionIdsWithOpenProposals(db: Database.Database, limit?: number): string[] {
	const rows = prep(db, "SELECT DISTINCT session_id FROM proposals WHERE status = 'open' ORDER BY session_id")
		.all() as Array<{ session_id: string }>;
	const ids = rows.map((r) => r.session_id);
	return typeof limit === "number" ? ids.slice(0, limit) : ids;
}

/** Count open proposals grouped by validation status, for a run summary. */
export function countOpenProposalsByValidationStatus(db: Database.Database): Record<string, number> {
	const rows = prep(db, "SELECT validation_status AS s, COUNT(*) AS c FROM proposals WHERE status = 'open' GROUP BY validation_status")
		.all() as Array<{ s: string; c: number }>;
	const out: Record<string, number> = {};
	for (const r of rows) out[r.s] = r.c;
	return out;
}

// ── Stats ──

export function getStats(db: Database.Database, asOf?: string): Stats {
	const at = asOf;
	const sessionWhere = at ? " WHERE started_at <= ?" : "";
	const sessionParams = at ? [at] : [];
	const totalSessions = (prep(db, `SELECT COUNT(*) as c FROM sessions${sessionWhere}`).get(...sessionParams) as { c: number }).c;
	const piSessions = (prep(db, `SELECT COUNT(*) as c FROM sessions WHERE source = 'pi'${at ? " AND started_at <= ?" : ""}`).get(...(at ? [at] : [])) as { c: number }).c;
	const claudeSessions = (prep(db, `SELECT COUNT(*) as c FROM sessions WHERE source = 'claude'${at ? " AND started_at <= ?" : ""}`).get(...(at ? [at] : [])) as { c: number }).c;

	const msgWhere = at ? ` AND timestamp <= ?` : "";
	const msgParams = at ? [at] : [];
	const totalMessages = (prep(db, `SELECT COUNT(*) as c FROM messages WHERE role IN ('user','assistant')${msgWhere}`).get(...msgParams) as { c: number }).c;
	const piMessages = (prep(db, `SELECT COUNT(*) as c FROM messages WHERE role IN ('user','assistant') AND source = 'pi'${msgWhere}`).get(...msgParams) as { c: number }).c;
	const claudeMessages = (prep(db, `SELECT COUNT(*) as c FROM messages WHERE role IN ('user','assistant') AND source = 'claude'${msgWhere}`).get(...msgParams) as { c: number }).c;
	const totalToolResults = (prep(db, `SELECT COUNT(*) as c FROM messages WHERE role = 'toolResult'${msgWhere}`).get(...msgParams) as { c: number }).c;
	const sessionsAnalyzed = (prep(db, `SELECT COUNT(*) as c FROM sessions WHERE analyzed_at IS NOT NULL${at ? " AND analyzed_at <= ?" : ""}`).get(...(at ? [at] : [])) as { c: number }).c;

	const proposalsByStatus = proposalStatusCountsAt(db, at);


	return {
		totalSessions,
		piSessions,
		claudeSessions,
		totalMessages,
		piMessages,
		claudeMessages,
		totalToolResults,
		sessionsAnalyzed,
		proposalsByStatus,
		analysis: getAnalysisStats(db, at),
		tokens: getTokenStats(db),
	};
}

// ── Token stats (per-source token & tool-call aggregation) ──

/**
 * Compute per-source token and tool-call stats from the messages table.
 *
 * Usage is stored as a JSON column: {"input":N,"output":N,"cacheRead":N,...}
 * Tool calls are stored as a JSON array; we count the array length.
 */
export function getTokenStats(db: Database.Database): SourceTokenStats {
	function query(source: string | null): TokenStats {
		const sourceClause = source ? "AND source = ?" : "";
		const params: unknown[] = source ? [source] : [];

		// Count turns and tool calls for assistant messages that have usage
		const row = prep(db, `
			SELECT
				COUNT(*) as turnCount,
				COALESCE(SUM(json_extract(usage, '$.input')), 0) as totalInput,
				COALESCE(SUM(json_extract(usage, '$.output')), 0) as totalOutput,
				COALESCE(SUM(json_extract(usage, '$.cacheRead')), 0) as totalCacheRead,
				COALESCE(SUM(json_extract(usage, '$.cacheWrite')), 0) as totalCacheWrite,
				COALESCE(SUM(json_extract(usage, '$.totalTokens')), 0) as totalTokens
			FROM messages
			WHERE role = 'assistant'
				AND usage IS NOT NULL
				AND json_extract(usage, '$.input') IS NOT NULL
				${sourceClause}
		`).get(...params) as {
			turnCount: number;
			totalInput: number;
			totalOutput: number;
			totalCacheRead: number;
			totalCacheWrite: number;
			totalTokens: number;
		};

		// Count tool calls from tool_calls JSON array
		const tcRow = prep(db, `
			SELECT
				COALESCE(SUM(CASE
					WHEN tool_calls IS NOT NULL AND tool_calls != '[]'
					THEN json_array_length(tool_calls)
					ELSE 0
				END), 0) as toolCallCount
			FROM messages
			WHERE role = 'assistant'
				AND usage IS NOT NULL
				${sourceClause}
		`).get(...params) as { toolCallCount: number };

		const turns = row.turnCount;
		const inputPerTurn = turns > 0 ? Math.round(row.totalInput / turns) : 0;
		const outputPerTurn = turns > 0 ? Math.round(row.totalOutput / turns) : 0;
		const cacheReadPerTurn = turns > 0 ? Math.round(row.totalCacheRead / turns) : 0;
		const toolCallsPerTurn = turns > 0 ? Math.round((tcRow.toolCallCount / turns) * 10) / 10 : 0;

		return {
			totalInput: row.totalInput,
			totalOutput: row.totalOutput,
			totalCacheRead: row.totalCacheRead,
			totalCacheWrite: row.totalCacheWrite,
			totalTokens: row.totalTokens,
			turnCount: turns,
			toolCallCount: tcRow.toolCallCount,
			inputPerTurn,
			outputPerTurn,
			cacheReadPerTurn,
			toolCallsPerTurn,
		};
	}

	const combined = query(null);
	const pi = query("pi");
	const claude = query("claude");

	function ratio(piVal: number, claudeVal: number): number | null {
		return claudeVal === 0 ? null : Math.round((piVal / claudeVal) * 10) / 10;
	}

	return {
		combined,
		pi,
		claude,
		ratios: {
			turns: ratio(pi.turnCount, claude.turnCount),
			toolCalls: ratio(pi.toolCallCount, claude.toolCallCount),
			input: ratio(pi.totalInput, claude.totalInput),
			output: ratio(pi.totalOutput, claude.totalOutput),
			cacheRead: ratio(pi.totalCacheRead, claude.totalCacheRead),
			cacheWrite: ratio(pi.totalCacheWrite, claude.totalCacheWrite),
			inputPerTurn: ratio(pi.inputPerTurn, claude.inputPerTurn),
			outputPerTurn: ratio(pi.outputPerTurn, claude.outputPerTurn),
			toolCallsPerTurn: ratio(pi.toolCallsPerTurn, claude.toolCallsPerTurn),
		},
	};
}