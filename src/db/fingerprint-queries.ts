import type { AsyncDatabase } from "./async-db.js";
import { prep } from "./prepared.js";
import { NOT_MUTED_AS_OF, NOT_REVISED_AS_OF } from "./current-generation.js";

/**
 * Read-only aggregates for the corpus fingerprint. Nothing here selects a
 * session id, path, title, project, cwd, message text, or the content of a
 * node beyond the few fixed fields named below: the fingerprint builder gets
 * numbers and short enum values, and groups them.
 *
 * The node readers are generic: a contributor names JSON paths into a node's
 * content and gets back rows of numbers and short strings. The paths are bound
 * as parameters, never spliced into the SQL, and must look like `$.a.b`.
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
		// An empty selection matches no session; `IN ()` is a syntax error.
		terms.push(scope.sources.length === 0 ? "0" : `s.source IN (${scope.sources.map(() => "?").join(", ")})`);
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

/**
 * For each session in scope, the version of the analyzer's latest successful
 * run by the instant. Runs that started at the same instant are ordered by id,
 * so the answer does not depend on the order SQLite returns them in.
 */
export async function latestRunVersions(db: AsyncDatabase, scope: FingerprintScope, analyzerId: string): Promise<Map<string, string>> {
	const { terms, params } = scopeTerms(scope);
	const rows = (await prep(
		db,
		`SELECT s.id AS id, r.analyzer_version_id AS version FROM analysis_runs r JOIN sessions s ON s.id = r.session_id
		  WHERE r.analyzer_id = ? AND r.status = 'ok' AND r.started_at <= ? AND ${terms.join(" AND ")}
		  ORDER BY r.started_at, r.id`,
	).all(analyzerId, scope.asOf, ...params)) as Array<{ id: string; version: string }>;
	return new Map(rows.map((r) => [r.id, r.version]));
}

/** One row per (session, version) among the analyzer's current nodes in scope. */
export async function currentNodeVersions(db: AsyncDatabase, scope: FingerprintScope, analyzerId: string): Promise<Array<{ session: string; version: string }>> {
	const { from, params } = currentNodes(scope);
	return (await prep(db, `SELECT DISTINCT n.session_id AS session, n.analyzer_version_id AS version FROM ${from}`).all(analyzerId, ...params)) as Array<{
		session: string;
		version: string;
	}>;
}

/**
 * One step of a JSON path: `.name`, or `."name-with-dashes"` for a key that is
 * not an identifier (an analyzer's class ids, such as `cold-ttl`, key its counts).
 */
const STEP = String.raw`\.(?:[A-Za-z_][A-Za-z0-9_]*|"[A-Za-z0-9_-]+")`;
/** A JSON path into node content: `$` followed by steps. */
const JSON_PATH = new RegExp(`^\\$(?:${STEP})+$`);
/** A path relative to an array item, which may be the item itself, or step into a list it holds (`$.members[0].hash`). */
const ITEM_PATH = new RegExp(String.raw`^\$(?:${STEP}(?:\[[0-9]{1,3}\])?)*$`);
/** Reads an item's key (the member's name in an object, the position in an array) instead of a path into it. */
const ITEM_KEY = "#key";

function checkPaths(paths: readonly string[], pattern: RegExp): void {
	for (const path of paths) if (!pattern.test(path)) throw new Error(`'${path}' is not a JSON path of the form $.a.b or $.a."b-c"`);
}

/** A scalar read out of node content. */
export type NodeScalar = string | number | null;

/**
 * One row per current node of the analyzer, with each named field read from
 * its content, oldest node first. `session` is the node's session.
 */
export async function currentNodeRows(
	db: AsyncDatabase,
	scope: FingerprintScope,
	analyzerId: string,
	fields: Readonly<Record<string, string>>,
): Promise<Array<Record<string, NodeScalar>>> {
	const names = Object.keys(fields);
	const paths = names.map((name) => fields[name]!);
	checkPaths(paths, JSON_PATH);
	const { from, params } = currentNodes(scope);
	const select = names.map((_, i) => extracted("n.content_json", `f${i}`));
	const rows = (await prep(db, `SELECT n.session_id AS session${select.length > 0 ? ", " + select.join(", ") : ""} FROM ${from} ORDER BY n.created_at, n.id`).all(
		...twice(paths),
		analyzerId,
		...params,
	)) as Array<Record<string, unknown>>;
	return rows.map((row) => Object.fromEntries([["session", row["session"] as string], ...names.map((name, i) => [name, scalar(row, `f${i}`)])]));
}

/**
 * One row per element of an array, or per member of an object, in each current
 * node's content. `itemFields` are read from the element (`$.name`, `$` for the
 * element itself, or `#key` for its key) and `nodeFields` from the node, so a
 * row can carry both.
 */
export async function currentNodeItems(
	db: AsyncDatabase,
	scope: FingerprintScope,
	analyzerId: string,
	arrayPath: string,
	itemFields: Readonly<Record<string, string>>,
	nodeFields: Readonly<Record<string, string>> = {},
): Promise<Array<Record<string, NodeScalar>>> {
	const itemNames = Object.keys(itemFields).filter((name) => itemFields[name] !== ITEM_KEY);
	const nodeNames = Object.keys(nodeFields);
	const keyNames = Object.keys(itemFields).filter((name) => itemFields[name] === ITEM_KEY);
	const itemPaths = itemNames.map((name) => itemFields[name]!);
	const nodePaths = nodeNames.map((name) => nodeFields[name]!);
	checkPaths([arrayPath, ...nodePaths], JSON_PATH);
	checkPaths(itemPaths, ITEM_PATH);
	const { from, params } = currentNodes(scope, ", json_each(n.content_json, ?) g");
	// An element is read through its full path in the node, `g.fullkey` plus the item path after `$`,
	// because a scalar element in `g.value` is not JSON and `json_type` rejects it.
	const select = [
		...itemNames.map((_, i) => extracted("n.content_json", `i${i}`, "g.fullkey || substr(?, 2)")),
		...nodeNames.map((_, i) => extracted("n.content_json", `n${i}`)),
		...keyNames.map((_, i) => `CAST(g.key AS TEXT) AS k${i}`),
	];
	const rows = (await prep(db, `SELECT n.session_id AS session${select.length > 0 ? ", " + select.join(", ") : ""} FROM ${from}`).all(
		...twice(itemPaths),
		...twice(nodePaths),
		arrayPath,
		analyzerId,
		...params,
	)) as Array<Record<string, NodeScalar>>;
	return rows.map((row) =>
		Object.fromEntries([
			["session", row["session"] as string],
			...itemNames.map((name, i) => [name, scalar(row, `i${i}`)]),
			...nodeNames.map((name, i) => [name, scalar(row, `n${i}`)]),
			...keyNames.map((name, i) => [name, row[`k${i}`] ?? null]),
		]),
	);
}

/**
 * Select the value at a JSON path as `alias`, and its JSON type as `alias_t`.
 * `json_extract` returns an object or an array as JSON text, which reads as a
 * string, so only the type tells it from a string value. Takes the path twice.
 */
function extracted(source: string, alias: string, path = "?"): string {
	return `json_extract(${source}, ${path}) AS ${alias}, json_type(${source}, ${path}) AS ${alias}_t`;
}

/** Each path twice, in the order `extracted` reads them. */
function twice(paths: readonly string[]): string[] {
	return paths.flatMap((p) => [p, p]);
}

/** Numbers and strings pass; an object or an array is not a shareable scalar, so it reads as no value. */
function scalar(row: Record<string, unknown>, alias: string): NodeScalar {
	const type = row[`${alias}_t`];
	if (type === "object" || type === "array") return null;
	const value = row[alias];
	return typeof value === "number" || typeof value === "string" ? value : null;
}

/**
 * Whether the analyzer has live nodes but no record that its lineage was
 * repaired (`lineage_repairs`). Its current nodes may then hold two generations
 * of one subject. An index the read-only fingerprint opens before any migration
 * added the table has had no repair either.
 */
export async function lineageUnrepaired(db: AsyncDatabase, analyzerId: string): Promise<boolean> {
	const hasNodes = await prep(db, "SELECT 1 FROM live_nodes WHERE analyzer_id = ? LIMIT 1").get(analyzerId);
	if (hasNodes === undefined) return false;
	const table = await prep(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lineage_repairs'").get();
	if (table === undefined) return true;
	return (await prep(db, "SELECT 1 FROM lineage_repairs WHERE analyzer_id = ?").get(analyzerId)) === undefined;
}
