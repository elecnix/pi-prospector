	import { type AsyncDatabase } from "./async-db.js";
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
import type { SubagentRunRow } from "../analyze/types.js";
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
	/** Human-readable session name, or null when the transcript recorded none. */
	name: string | null;
	/** JSON ToolInventory, or null = UNKNOWN (never captured). '[]' = empty. */
	tool_inventory: string | null;
}

export async function upsertSession(db: AsyncDatabase, s: SessionInsert): Promise<void> {
	await prep(db, `
		INSERT INTO sessions (id, file_path, project, source, cwd, parent_session, started_at, last_line, last_modified, analyzed_at, message_count, branch_count, name, tool_inventory)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			file_path=excluded.file_path, project=excluded.project, source=excluded.source, cwd=excluded.cwd,
			parent_session=excluded.parent_session, last_line=excluded.last_line,
			last_modified=excluded.last_modified, message_count=excluded.message_count,
			branch_count=excluded.branch_count, name=excluded.name, tool_inventory=excluded.tool_inventory
	`).run(s.id, s.file_path, s.project, s.source, s.cwd, s.parent_session, s.started_at, s.last_line, s.last_modified, s.analyzed_at, s.message_count, s.branch_count, s.name, s.tool_inventory);
}

export async function getCursor(db: AsyncDatabase, filePath: string): Promise<{ last_line: number; last_modified: number } | undefined> {
	return (await prep(db, "SELECT last_line, last_modified FROM sessions WHERE file_path = ?").get(filePath)) as { last_line: number; last_modified: number } | undefined;
}

export async function updateCursor(db: AsyncDatabase, sessionId: string, lastLine: number, lastModified: number): Promise<void> {
	await prep(db, "UPDATE sessions SET last_line = ?, last_modified = ? WHERE id = ?").run(lastLine, lastModified, sessionId);
}

export async function updateMessageCount(db: AsyncDatabase, sessionId: string, count: number): Promise<void> {
	await prep(db, "UPDATE sessions SET message_count = ? WHERE id = ?").run(count, sessionId);
}

export async function markAnalyzed(db: AsyncDatabase, sessionId: string): Promise<void> {
	await prep(db, "UPDATE sessions SET analyzed_at = ? WHERE id = ?").run(new Date().toISOString(), sessionId);
}

export async function getUnanalyzedSessions(db: AsyncDatabase, limit?: number, source?: string): Promise<Array<{ id: string; file_path: string; started_at: string }>> {
	const sourceClause = source ? " AND source = ?" : "";
	const params = source ? [source] : [];
	const sql = limit
		? `SELECT id, file_path, started_at FROM sessions WHERE analyzed_at IS NULL${sourceClause} ORDER BY started_at ASC LIMIT ?`
		: `SELECT id, file_path, started_at FROM sessions WHERE analyzed_at IS NULL${sourceClause} ORDER BY started_at ASC`;
	return (await (limit
		? prep(db, sql).all(...[...params, limit])
		: prep(db, sql).all(...params))) as Array<{ id: string; file_path: string; started_at: string }>;
}

export async function getAllSessions(db: AsyncDatabase, limit?: number, source?: string): Promise<Array<{ id: string; file_path: string; started_at: string }>> {
	const sourceClause = source ? " WHERE source = ?" : "";
	const params = source ? [source] : [];
	const sql = limit
		? `SELECT id, file_path, started_at FROM sessions${sourceClause} ORDER BY started_at ASC LIMIT ?`
		: `SELECT id, file_path, started_at FROM sessions${sourceClause} ORDER BY started_at ASC`;
	return (await (limit
		? prep(db, sql).all(...[...params, limit])
		: prep(db, sql).all(...params))) as Array<{ id: string; file_path: string; started_at: string }>;
}

/** Get the N most-recent sessions by started_at, useful for pilots. */
export async function getRecentSessions(db: AsyncDatabase, limit: number, source?: string): Promise<Array<{ id: string; file_path: string; started_at: string }>> {
	if (!source) {
		return (await prep(db, "SELECT id, file_path, started_at FROM sessions ORDER BY started_at DESC LIMIT ?").all(limit)) as Array<{ id: string; file_path: string; started_at: string }>;
	}
	return (await prep(db, "SELECT id, file_path, started_at FROM sessions WHERE source = ? ORDER BY started_at DESC LIMIT ?").all(source, limit)) as Array<{ id: string; file_path: string; started_at: string }>;
}

export interface SessionLabel {
	id: string;
	project: string;
	cwd: string;
	message_count: number;
	/** The coding harness this session came from: "pi" | "claude". */
	source: string;
	/** Human-readable session name, or null when the transcript recorded none. */
	name: string | null;
}

/** Lightweight labels (project/cwd/message_count/source/name) for every session, for display. */
export async function getSessionLabels(db: AsyncDatabase): Promise<SessionLabel[]> {
	return (await prep(db, "SELECT id, project, cwd, message_count, source, name FROM sessions").all()) as SessionLabel[];
}

// ── Subagent runs ──

export interface SubagentRunInsert {
	run_id: string;
	project: string;
	agent: string | null;
	task_excerpt: string | null;
	exit_code: number | null;
	error: string | null;
	model_attempts: string | null;
	usage: string | null;
	file_mtime: number;
}

/**
 * Upsert one child-run record. Ingestion skips unchanged files by mtime before
 * reaching this, so an unconditional conflict-update is correct: reaching here
 * means the artifact changed, and the newer reading wins.
 */
export async function upsertSubagentRun(db: AsyncDatabase, r: SubagentRunInsert): Promise<void> {
	await prep(db, `
		INSERT INTO subagent_runs (run_id, project, agent, task_excerpt, exit_code, error, model_attempts, usage, file_mtime, ingested_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(run_id) DO UPDATE SET
			project=excluded.project, agent=excluded.agent, task_excerpt=excluded.task_excerpt,
			exit_code=excluded.exit_code, error=excluded.error, model_attempts=excluded.model_attempts,
			usage=excluded.usage, file_mtime=excluded.file_mtime, ingested_at=excluded.ingested_at
	`).run(r.run_id, r.project, r.agent, r.task_excerpt, r.exit_code, r.error, r.model_attempts, r.usage, r.file_mtime, new Date().toISOString());
}

/** The stored file mtime for a run, or undefined when it has never been ingested. */
export async function getSubagentRunMtime(db: AsyncDatabase, runId: string): Promise<number | undefined> {
	const row = (await prep(db, "SELECT file_mtime FROM subagent_runs WHERE run_id = ?").get(runId)) as { file_mtime: number } | undefined;
	return row?.file_mtime;
}

/**
 * Every subagent run recorded for a session's project.
 *
 * The join is by directory nesting — the artifacts directory sits beside the
 * parent session files in the same project directory — so `project` is the
 * whole join key. That makes the attachment corpus-wide rather than per-run:
 * every session of a project sees that project's child runs, which is honest
 * until a stronger parent link exists (see issue #157 for child sessions).
 */
export async function getSubagentRunsForSession(db: AsyncDatabase, sessionId: string): Promise<SubagentRunRow[]> {
	return (await prep(db,
		"SELECT r.run_id, r.project, r.agent, r.task_excerpt, r.exit_code, r.error, r.model_attempts, r.usage, r.file_mtime, r.ingested_at " +
		"FROM subagent_runs r JOIN sessions s ON s.project = r.project " +
		"WHERE s.id = ? ORDER BY r.run_id ASC",
	).all(sessionId)) as SubagentRunRow[];
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

export async function insertMessage(db: AsyncDatabase, m: MessageInsert): Promise<void> {
	await prep(db, `
		INSERT OR IGNORE INTO messages (id, session_id, source, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, usage, content_hash, model, cost_usd, provider_message_id, stop_reason, error_message)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(m.id, m.session_id, m.source, m.parent_id, m.timestamp, m.role, m.content_text, m.content_thinking, m.tool_calls, m.tool_results, m.usage, null, m.model, m.cost_usd, m.provider_message_id, m.stop_reason, m.error_message);
}

export async function countMessages(db: AsyncDatabase, sessionId: string): Promise<number> {
	return ((await prep(db, "SELECT COUNT(*) as c FROM messages WHERE session_id = ?").get(sessionId)) as { c: number }).c;
}

export async function getSessionMessages(db: AsyncDatabase, sessionId: string): Promise<Array<{ role: string; content_text: string | null; content_thinking: string | null; tool_calls: string | null; timestamp: string | null }>> {
	return (await prep(db, "SELECT role, content_text, content_thinking, tool_calls, timestamp FROM messages WHERE session_id = ? ORDER BY rowid ASC").all(sessionId)) as any[];
}

// ── Proposals (v2) ──

export async function listProposals(
	db: AsyncDatabase,
	status?: string,
	severity?: string,
	limit?: number,
	offset?: number,
	source?: string,
	sessionId?: string,
): Promise<Proposal[]> {
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
	if (sessionId) {
		clauses.push("session_id = ?");
		params.push(sessionId);
	}
	if (source) {
		clauses.push("s.source = ?");
		params.push(source);
	}
	// Join sessions when filtering by source, so a proposal is matched through the
	// harness of the session it came from (the proposal row itself has no source).
	// The join also disambiguates `session_id` (it lives on both tables), which is
	// why the prefix mapping below qualifies every non-`s.` clause when joined.
	const join = source ? " JOIN sessions s ON s.id = p.session_id" : "";
	const prefix = source ? "p." : "";
	const where = clauses.length
		? ` WHERE ${clauses.map((c) => (source && !c.startsWith("s.") ? `${prefix}${c}` : c)).join(" AND ")}`
		: "";
	let sql = `SELECT ${source ? "p." : ""}* FROM proposals${source ? " p" : ""}${join}${where} ORDER BY ${source ? "p." : ""}created_at DESC`;
	if (limit !== undefined) {
		sql += ` LIMIT ?`;
		params.push(limit);
		if (offset !== undefined) {
			sql += ` OFFSET ?`;
			params.push(offset);
		}
	}
	return (await prep(db, sql).all(...params)) as Proposal[];
}

export async function getProposal(db: AsyncDatabase, id: string): Promise<Proposal | undefined> {
	return (await prep(db, "SELECT * FROM proposals WHERE id = ?").get(id)) as Proposal | undefined;
}

/**
 * The latest decision recorded at or before T for each proposal, keyed by
 * `proposal_input_key`. The decision log is the event source that makes the
 * mutable `proposals.status` projection reconstructible at a point in time.
 */
async function latestDecisionsAsOf(db: AsyncDatabase, at: string): Promise<Map<string, ProposalDecision>> {
	const rows = (await db
		.prepare("SELECT * FROM proposal_decisions WHERE decided_at <= ? ORDER BY decided_at ASC, rowid ASC")
		.all(at)) as ProposalDecision[];
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
export async function listProposalsAsOf(db: AsyncDatabase, at: string, source?: string): Promise<Proposal[]> {
	const proposals = (await (source
		? db.prepare(
			"SELECT p.* FROM proposals p JOIN sessions s ON s.id = p.session_id WHERE p.created_at <= ? AND s.source = ? ORDER BY p.created_at DESC",
		).all(at, source)
		: db.prepare("SELECT * FROM proposals WHERE created_at <= ? ORDER BY created_at DESC").all(at))) as Proposal[];
	const latest = await latestDecisionsAsOf(db, at);
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
async function proposalStatusCountsAt(db: AsyncDatabase, at?: string): Promise<Record<ProposalStatus, number>> {
	const counts: Record<ProposalStatus, number> = { open: 0, applied: 0, rejected: 0, duplicate: 0 };
	if (at === undefined) {
		const rows = (await db.prepare("SELECT status, COUNT(*) AS c FROM proposals GROUP BY status").all()) as Array<{
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
	for (const p of await listProposalsAsOf(db, at)) {
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

async function decideProposal(
	db: AsyncDatabase,
	id: string,
	newStatus: ProposalStatus,
	verdict: DecisionVerdict,
	input?: DecisionInput,
	remediationId?: string | null,
): Promise<boolean> {
	const row = (await prep(db, "SELECT input_key, status FROM proposals WHERE id = ?").get(id)) as
		| { input_key: string; status: string }
		| undefined;
	if (!row || row.status !== "open") return false;
	const now = new Date().toISOString();
	const tx = db.transaction(async () => {
		await prep(db, "UPDATE proposals SET status = ?, updated_at = ? WHERE id = ?").run(newStatus, now, id);
		// The decision is written to the legacy table (the reversible rollback)
		// AND to the assertions relation, the canonical view keyed by the
		// content-addressed proposal input_key (issue #73). Both in one transaction
		// so they never diverge; reads go through assertions. The legacy table is
		// kept, still written, until a separate change retires it.
		await prep(db, 
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
		await upsertAssertion(db, {
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
	await tx();
	return true;
}

/** The verdict an accept records: done_differently means the idea was applied in a modified form. */
function acceptVerdict(input?: DecisionInput): DecisionVerdict {
	return input?.disposition === "done_differently" ? "accepted_modified" : "accepted";
}

export async function acceptProposal(db: AsyncDatabase, id: string, input?: DecisionInput): Promise<boolean> {
	return decideProposal(db, id, "applied", acceptVerdict(input), input);
}

export async function rejectProposal(db: AsyncDatabase, id: string, input?: DecisionInput): Promise<boolean> {
	return decideProposal(db, id, "rejected", "rejected", input);
}

// ── Bulk accept / reject ──

export interface BulkResult {
	accepted: string[];
	rejected: string[];
	skipped: string[];
}

/** Accept multiple proposals with the same decision input (no remediation row). */
export async function acceptProposalsBulk(
	db: AsyncDatabase,
	proposalIds: string[],
	input?: DecisionInput,
): Promise<BulkResult> {
	const accepted: string[] = [];
	const skipped: string[] = [];
	const verdict = acceptVerdict(input);
	const tx = db.transaction(async () => {
		for (const id of proposalIds) {
			if (await decideProposal(db, id, "applied", verdict, input)) accepted.push(id);
			else skipped.push(id);
		}
	});
	await tx();
	return { accepted, rejected: [], skipped };
}

/** Reject multiple proposals with the same decision input. */
export async function rejectProposalsBulk(
	db: AsyncDatabase,
	proposalIds: string[],
	input?: DecisionInput,
): Promise<BulkResult> {
	const rejected: string[] = [];
	const skipped: string[] = [];
	const tx = db.transaction(async () => {
		for (const id of proposalIds) {
			if (await decideProposal(db, id, "rejected", "rejected", input)) rejected.push(id);
			else skipped.push(id);
		}
	});
	await tx();
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
export async function acceptProposalsWithRemediation(
	db: AsyncDatabase,
	proposalIds: string[],
	remediation: RemediationInput,
	input?: DecisionInput,
): Promise<RemediateResult> {
	const decision: DecisionInput = {
		...input,
		rationale: input?.rationale ?? remediation.description,
		actual_change: input?.actual_change ?? remediation.actual_change ?? null,
	};
	const accepted: string[] = [];
	const skipped: string[] = [];
	let remediationId: string | null = null;
	const tx = db.transaction(async () => {
		const open = new Set<string>();
		for (const id of proposalIds) {
			const row = (await prep(db, "SELECT status FROM proposals WHERE id = ?").get(id)) as { status: string } | undefined;
			if (row?.status === "open") open.add(id);
		}
		if (open.size > 0) {
			remediationId = uuidv7();
			const createdAt = new Date().toISOString();
			await prep(db, "INSERT INTO remediations (id, description, actual_change, created_at) VALUES (?, ?, ?, ?)").run(
				remediationId,
				remediation.description,
				remediation.actual_change ?? null,
				createdAt,
			);
			// Also record the shared remediation as an assertion (issue #73), so the
			// disaster corpus is uniform; decisions reference it via remediation_id.
			await upsertAssertion(db, {
				subjectKind: ASSERTION_SUBJECT_KINDS.REMEDIATION,
				subjectKey: remediationId,
				verdict: REMEDIATION_VERDICT,
				reason: remediation.description,
				assertedAt: createdAt,
				actualChange: remediation.actual_change ?? null,
			});
		}
		for (const id of proposalIds) {
			if (open.has(id) && (await decideProposal(db, id, "applied", acceptVerdict(decision), decision, remediationId))) {
				accepted.push(id);
			} else {
				skipped.push(id);
			}
		}
	});
	await tx();
	return { remediationId, accepted, skipped };
}

export async function getRemediation(db: AsyncDatabase, id: string): Promise<Remediation | undefined> {
	const a = await getRemediationAssertion(db, id);
	return a ? assertionToRemediation(a) : undefined;
}

/** Every decision made under one remediation, oldest first. */
export async function getDecisionsForRemediation(db: AsyncDatabase, remediationId: string): Promise<ProposalDecision[]> {
	return (await getProposalAssertionsByRemediation(db, remediationId)).map(assertionToDecision);
}

// ── Proposal decisions (append-only human feedback) ──

/** The latest (authoritative) decision for a proposal's input_key, if any. */
export async function getLatestDecision(db: AsyncDatabase, proposalInputKey: string): Promise<ProposalDecision | undefined> {
	const rows = await getProposalAssertionsForKey(db, proposalInputKey);
	if (rows.length === 0) return undefined;
	// Oldest-first, so the latest (authoritative) decision is the last row.
	return assertionToDecision(rows[rows.length - 1]!);
}

/** Full decision history for one proposal, oldest first. */
export async function getDecisionsForProposal(db: AsyncDatabase, proposalInputKey: string): Promise<ProposalDecision[]> {
	return (await getProposalAssertionsForKey(db, proposalInputKey)).map(assertionToDecision);
}

/** Every decision, newest first — the corpus the future meta-analyzer consumes. */
export async function getAllDecisions(db: AsyncDatabase): Promise<ProposalDecision[]> {
	return (await getProposalAssertions(db)).map(assertionToDecision);
}

// ── Proposal validation (issue #6) ──

/** Open proposals for a session, in stable order — the input to proposal-validate. */
export async function listOpenProposalsForSession(db: AsyncDatabase, sessionId: string): Promise<Proposal[]> {
	return (await prep(db, "SELECT * FROM proposals WHERE session_id = ? AND status = 'open' ORDER BY created_at ASC, rowid ASC")
		.all(sessionId)) as Proposal[];
}

/** Distinct session ids that currently have at least one open proposal to validate. */
export async function listSessionIdsWithOpenProposals(db: AsyncDatabase, limit?: number): Promise<string[]> {
	const rows = (await prep(db, "SELECT DISTINCT session_id FROM proposals WHERE status = 'open' ORDER BY session_id")
		.all()) as Array<{ session_id: string }>;
	const ids = rows.map((r) => r.session_id);
	return typeof limit === "number" ? ids.slice(0, limit) : ids;
}

/** Count open proposals grouped by validation status, for a run summary. */
export async function countOpenProposalsByValidationStatus(db: AsyncDatabase): Promise<Record<string, number>> {
	const rows = (await prep(db, "SELECT validation_status AS s, COUNT(*) AS c FROM proposals WHERE status = 'open' GROUP BY validation_status")
		.all()) as Array<{ s: string; c: number }>;
	const out: Record<string, number> = {};
	for (const r of rows) out[r.s] = r.c;
	return out;
}

// ── Stats ──

export async function getStats(db: AsyncDatabase, asOf?: string): Promise<Stats> {
	const at = asOf;
	const sessionWhere = at ? " WHERE started_at <= ?" : "";
	const sessionParams = at ? [at] : [];
	const totalSessions = ((await prep(db, `SELECT COUNT(*) as c FROM sessions${sessionWhere}`).get(...sessionParams)) as { c: number }).c;
	const piSessions = ((await prep(db, `SELECT COUNT(*) as c FROM sessions WHERE source = 'pi'${at ? " AND started_at <= ?" : ""}`).get(...(at ? [at] : []))) as { c: number }).c;
	const claudeSessions = ((await prep(db, `SELECT COUNT(*) as c FROM sessions WHERE source = 'claude'${at ? " AND started_at <= ?" : ""}`).get(...(at ? [at] : []))) as { c: number }).c;

	const msgWhere = at ? ` AND timestamp <= ?` : "";
	const msgParams = at ? [at] : [];
	const totalMessages = ((await prep(db, `SELECT COUNT(*) as c FROM messages WHERE role IN ('user','assistant')${msgWhere}`).get(...msgParams)) as { c: number }).c;
	const piMessages = ((await prep(db, `SELECT COUNT(*) as c FROM messages WHERE role IN ('user','assistant') AND source = 'pi'${msgWhere}`).get(...msgParams)) as { c: number }).c;
	const claudeMessages = ((await prep(db, `SELECT COUNT(*) as c FROM messages WHERE role IN ('user','assistant') AND source = 'claude'${msgWhere}`).get(...msgParams)) as { c: number }).c;
	const totalToolResults = ((await prep(db, `SELECT COUNT(*) as c FROM messages WHERE role = 'toolResult'${msgWhere}`).get(...msgParams)) as { c: number }).c;
	const sessionsAnalyzed = ((await prep(db, `SELECT COUNT(*) as c FROM sessions WHERE analyzed_at IS NOT NULL${at ? " AND analyzed_at <= ?" : ""}`).get(...(at ? [at] : []))) as { c: number }).c;

	const proposalsByStatus = await proposalStatusCountsAt(db, at);


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
		analysis: await getAnalysisStats(db, at),
		tokens: await getTokenStats(db),
	};
}

// ── Token stats (per-source token & tool-call aggregation) ──

/**
 * Compute per-source token and tool-call stats from the messages table.
 *
 * Usage is stored as a JSON column: {"input":N,"output":N,"cacheRead":N,...}
 * Tool calls are stored as a JSON array; we count the array length.
 */
export async function getTokenStats(db: AsyncDatabase): Promise<SourceTokenStats> {
	async function query(source: string | null): Promise<TokenStats> {
		const sourceClause = source ? "AND source = ?" : "";
		const params: unknown[] = source ? [source] : [];

		// Count turns and tool calls for assistant messages that have usage
		const row = (await prep(db, `
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
		`).get(...params)) as {
			turnCount: number;
			totalInput: number;
			totalOutput: number;
			totalCacheRead: number;
			totalCacheWrite: number;
			totalTokens: number;
		};

		// Count tool calls from tool_calls JSON array
		const tcRow = (await prep(db, `
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
		`).get(...params)) as { toolCallCount: number };

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

	const combined = await query(null);
	const pi = await query("pi");
	const claude = await query("claude");

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