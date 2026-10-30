import type { AsyncDatabase } from "./async-db.js";
import { prep } from "./prepared.js";
import { NOT_MUTED_AS_OF, NOT_REVISED_AS_OF } from "./current-generation.js";

/**
 * Read-only aggregates for the corpus fingerprint. Nothing here selects a
 * session id, path, title, project, cwd, message text, or the content of a
 * node beyond the few fixed fields named below: the fingerprint builder gets
 * numbers and short enum values, and groups them.
 *
 * Every query reads the session index and the graph as of one instant:
 * sessions that had started by then, messages stamped by then, and the
 * current generation of nodes that existed (and were not retracted) by then.
 * Only top-level sessions are in scope; a sub-agent's own session is counted
 * under its parent.
 */

export interface FingerprintScope {
	/** Harness sources to include, or null for all. */
	sources: readonly string[] | null;
	/** Earliest session start, inclusive, as an ISO instant; or null. */
	from: string | null;
	/** Latest session start, exclusive, as an ISO instant; or null. */
	toExclusive: string | null;
	/** The instant the sessions and the graph are read as of. */
	asOf: string;
}

/** The `WHERE` terms that select the sessions in scope, over the table aliased `s`. */
function scopeTerms(scope: FingerprintScope): { terms: string[]; params: string[] } {
	const terms = ["s.parent_session IS NULL", "(s.started_at IS NULL OR s.started_at <= ?)"];
	const params = [scope.asOf];
	if (scope.sources !== null) {
		terms.push(`s.source IN (${scope.sources.map(() => "?").join(", ")})`);
		params.push(...scope.sources);
	}
	if (scope.from !== null) {
		terms.push("s.started_at >= ?");
		params.push(scope.from);
	}
	if (scope.toExclusive !== null) {
		terms.push("s.started_at < ?");
		params.push(scope.toExclusive);
	}
	return { terms, params };
}

export interface SessionFacts {
	/** Opaque to the fingerprint: used to count a session once, never emitted. */
	id: string;
	source: string;
	startedAt: string | null;
	firstTimestamp: string | null;
	lastTimestamp: string | null;
	/** Messages with the `user` role. */
	prompts: number;
	toolCalls: number;
	/** Sessions that name this one as their parent. */
	subAgentSessions: number;
}

/** One row per session in scope, counted from the transcript. */
export async function sessionFacts(db: AsyncDatabase, scope: FingerprintScope): Promise<SessionFacts[]> {
	const { terms, params } = scopeTerms(scope);
	return (await prep(
		db,
		`SELECT s.id AS id, s.source AS source, s.started_at AS startedAt,
		        MIN(m.timestamp) AS firstTimestamp, MAX(m.timestamp) AS lastTimestamp,
		        COALESCE(SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END), 0) AS prompts,
		        COALESCE(SUM(CASE WHEN m.tool_calls IS NOT NULL AND json_valid(m.tool_calls) AND json_type(m.tool_calls) = 'array'
		                          THEN json_array_length(m.tool_calls) ELSE 0 END), 0) AS toolCalls,
		        (SELECT COUNT(*) FROM sessions c
		          WHERE c.parent_session = s.id AND (c.started_at IS NULL OR c.started_at <= ?)) AS subAgentSessions
		   FROM sessions s
		   LEFT JOIN messages m ON m.session_id = s.id AND (m.timestamp IS NULL OR m.timestamp <= ?)
		  WHERE ${terms.join(" AND ")}
		  GROUP BY s.id`,
	).all(scope.asOf, scope.asOf, ...params)) as SessionFacts[];
}

/**
 * The FROM and WHERE of "the current generation of one analyzer's nodes, for
 * sessions in scope, as of the instant". `extraFrom` joins a table function over
 * the node (`json_each`); the node is aliased `n`, the session `s`.
 */
function currentNodes(scope: FingerprintScope, extraFrom = ""): { from: string; params: string[] } {
	const { terms, params } = scopeTerms(scope);
	const at = scope.asOf;
	return {
		from: `analysis_nodes n JOIN sessions s ON s.id = n.session_id${extraFrom}
		  WHERE n.analyzer_id = ? AND n.node_kind != 'error'
		    AND n.created_at <= ? AND (n.retracted_at IS NULL OR n.retracted_at > ?)
		    AND ${NOT_REVISED_AS_OF} AND ${NOT_MUTED_AS_OF}
		    AND ${terms.join(" AND ")}`,
		params: [at, at, at, at, at, at, ...params],
	};
}

/** Sessions in scope with a successful run of the analyzer by the instant. */
export async function sessionsWithRun(db: AsyncDatabase, scope: FingerprintScope, analyzerId: string): Promise<Set<string>> {
	const { terms, params } = scopeTerms(scope);
	const rows = (await prep(
		db,
		`SELECT DISTINCT s.id AS id FROM analysis_runs r JOIN sessions s ON s.id = r.session_id
		  WHERE r.analyzer_id = ? AND r.status = 'ok' AND r.started_at <= ? AND ${terms.join(" AND ")}`,
	).all(analyzerId, scope.asOf, ...params)) as Array<{ id: string }>;
	return new Set(rows.map((r) => r.id));
}

/** The seconds of active time each session's time-economy node recorded. */
export async function activeSeconds(db: AsyncDatabase, scope: FingerprintScope): Promise<Array<{ id: string; seconds: number }>> {
	const { from, params } = currentNodes(scope);
	return (await prep(db, `SELECT n.session_id AS id, json_extract(n.content_json, '$.active_seconds') AS seconds FROM ${from}`).all(
		"time-economy",
		...params,
	)) as Array<{ id: string; seconds: number }>;
}

export interface FailureTotals {
	id: string;
	turnFailures: number;
	toolFailures: number;
}

/** The failure counts of each session's failure-modes node. */
export async function failureTotals(db: AsyncDatabase, scope: FingerprintScope): Promise<FailureTotals[]> {
	const { from, params } = currentNodes(scope);
	return (await prep(
		db,
		`SELECT n.session_id AS id,
		        COALESCE(json_extract(n.content_json, '$.turn_failure_count'), 0) AS turnFailures,
		        COALESCE(json_extract(n.content_json, '$.tool_failure_count'), 0) AS toolFailures
		   FROM ${from}`,
	).all("failure-modes", ...params)) as FailureTotals[];
}

export interface FailureGroupRow {
	id: string;
	axis: string | null;
	classId: string | null;
	count: number;
}

/** One row per failure class of each session's failure-modes node. */
export async function failureGroups(db: AsyncDatabase, scope: FingerprintScope): Promise<FailureGroupRow[]> {
	const { from, params } = currentNodes(scope, ", json_each(n.content_json, '$.groups') g");
	return (await prep(
		db,
		`SELECT n.session_id AS id, json_extract(g.value, '$.axis') AS axis,
		        json_extract(g.value, '$.class_id') AS classId, COALESCE(json_extract(g.value, '$.count'), 0) AS count
		   FROM ${from}`,
	).all("failure-modes", ...params)) as FailureGroupRow[];
}

export interface FrustrationRow {
	id: string;
	signalSource: string | null;
	polarity: string | null;
	category: string | null;
	/** Occurrences in text the person typed; null when the hit carries no origin label. */
	typed: number | null;
}

/** One row per turn-frustration hit. */
export async function frustrationHits(db: AsyncDatabase, scope: FingerprintScope): Promise<FrustrationRow[]> {
	const { from, params } = currentNodes(scope);
	return (await prep(
		db,
		`SELECT n.session_id AS id, json_extract(n.content_json, '$.signal_source') AS signalSource,
		        json_extract(n.content_json, '$.polarity') AS polarity, json_extract(n.content_json, '$.category') AS category,
		        json_extract(n.content_json, '$.origins.typed') AS typed
		   FROM ${from}`,
	).all("turn-frustration", ...params)) as FrustrationRow[];
}

export interface ClassificationRow {
	id: string;
	sentiment: string | null;
	frictionType: string | null;
}

/** One row per turn the classifier judged. */
export async function turnClassifications(db: AsyncDatabase, scope: FingerprintScope): Promise<ClassificationRow[]> {
	const { from, params } = currentNodes(scope);
	return (await prep(
		db,
		`SELECT n.session_id AS id, json_extract(n.content_json, '$.sentiment') AS sentiment,
		        json_extract(n.content_json, '$.friction_type') AS frictionType
		   FROM ${from}`,
	).all("turn-pair-llm", ...params)) as ClassificationRow[];
}
