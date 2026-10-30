import type { AsyncDatabase } from "../db/async-db.js";
import {
	activeSeconds,
	failureGroups,
	failureTotals,
	frustrationHits,
	sessionFacts,
	sessionsWithRun,
	turnClassifications,
	type FingerprintScope,
} from "../db/fingerprint-queries.js";
import { HARNESS_SOURCES, isHarnessSource, type HarnessSource } from "../harness.js";
import { failureClass, UNCLASSIFIED } from "../analyze/analyzers/failure-modes/classes.js";
import { parseTimestamp } from "../timepoint.js";
import { distribution, guardGroups, WITHHELD, type RawGroup } from "./guard.js";
import {
	DURATION_EDGES_MINUTES,
	FINGERPRINT_SCHEMA_VERSION,
	FRICTION_TYPES,
	FRUSTRATION_CATEGORIES,
	MIN_GROUP_SIZE,
	PROMPT_EDGES,
	SENTIMENTS,
	SOURCE_GROUPS,
	TOOL_CALL_EDGES,
	type Fingerprint,
	type FailureGroupOut,
	type SourceGroup,
} from "./schema.js";

/**
 * Derive a corpus fingerprint from the session index and the analysis graph.
 * The derivation is a read: it creates no node, run, edge, or proposal, and a
 * second call with the same arguments gives the same answer.
 */

/** What the caller asked for. */
export interface FingerprintRequest {
	/** Harness sources to include; null takes every source. */
	sources: HarnessSource[] | null;
	/** First session-start day to include, `YYYY-MM-DD`; null for no lower bound. */
	from: string | null;
	/** Last session-start day to include, `YYYY-MM-DD`; null for no upper bound. */
	to: string | null;
	/** The instant the corpus is read as of (an ISO timestamp). */
	asOf: string;
	/** Where to write the JSON; stdout when absent. */
	out?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(flag: string, value: string | undefined): string | null {
	if (value === undefined) return null;
	if (!DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new Error(`--${flag} takes a date as YYYY-MM-DD, got '${value}'`);
	return value;
}

/**
 * Parse `--source a,b` (repeatable), `--from DAY`, `--to DAY`, `--as-of DAY|ISO|7d`
 * and `--out FILE`. With no arguments the request takes everything, as of `now`.
 */
export function parseFingerprintArgs(raw: string, now: Date): FingerprintRequest {
	const tokens = (raw ?? "").trim().split(/\s+/).filter((t) => t.length > 0);
	const sources: string[] = [];
	const flags: Record<string, string> = {};
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (!token.startsWith("--")) throw new Error(`unexpected argument '${token}'`);
		const eq = token.indexOf("=");
		const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
		const value = eq === -1 ? tokens[++i] : token.slice(eq + 1);
		if (value === undefined || value === "" || (eq === -1 && value.startsWith("--"))) throw new Error(`--${name} needs a value`);
		if (name === "source") sources.push(...value.split(",").filter((s) => s.length > 0));
		else if (name === "from" || name === "to" || name === "as-of" || name === "out") flags[name] = value;
		else throw new Error(`unknown flag --${name} (use --source, --from, --to, --as-of, --out)`);
	}
	const chosen = sources.map((s) => {
		const source = s.trim().toLowerCase();
		if (!isHarnessSource(source)) throw new Error(`unknown source '${s}' (use ${HARNESS_SOURCES.join(", ")})`);
		return source;
	});
	const from = parseDay("from", flags["from"]);
	const to = parseDay("to", flags["to"]);
	if (from !== null && to !== null && to < from) throw new Error(`--to ${to} is before --from ${from}`);
	const asOfFlag = flags["as-of"];
	const asOf = asOfFlag === undefined ? now.toISOString() : DAY.test(asOfFlag) ? `${asOfFlag}T23:59:59.999Z` : parseTimestamp(asOfFlag);
	return { sources: chosen.length > 0 ? [...new Set(chosen)] : null, from, to, asOf, out: flags["out"] };
}

function toScope(request: FingerprintRequest): FingerprintScope {
	const nextDay = request.to === null ? null : new Date(Date.parse(`${request.to}T00:00:00Z`) + 86_400_000).toISOString();
	return {
		sources: request.sources,
		from: request.from === null ? null : `${request.from}T00:00:00.000Z`,
		toExclusive: nextDay,
		asOf: request.asOf,
	};
}

/** Group rows by key, keeping the sessions each key came from. */
function group<K extends string, R extends { id: string }>(rows: readonly R[], keyOf: (row: R) => K | null, countOf: (row: R) => number): Array<RawGroup<K>> {
	const groups = new Map<K, { count: number; ids: Set<string> }>();
	for (const row of rows) {
		const key = keyOf(row);
		const count = countOf(row);
		if (key === null || count <= 0) continue;
		const entry = groups.get(key) ?? { count: 0, ids: new Set<string>() };
		entry.count += count;
		entry.ids.add(row.id);
		groups.set(key, entry);
	}
	return [...groups].map(([key, entry]) => ({ key, count: entry.count, sessionIds: entry.ids }));
}

/** Largest first, then by key, so equal inputs always print the same. */
function ordered<T extends { key: string; count: number }>(groups: T[]): T[] {
	return [...groups].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function member<T extends string>(values: readonly T[], value: string | null | undefined): T | "other" {
	return values.find((v) => v === value) ?? "other";
}

function utcDay(iso: string): string {
	return iso.slice(0, 10);
}

function minutesBetween(first: string | null, last: string | null): number | null {
	if (first === null || last === null) return null;
	const ms = Date.parse(last) - Date.parse(first);
	return Number.isNaN(ms) || ms < 0 ? null : Math.round((ms / 60_000) * 100) / 100;
}

/** The failure classes of the failure-modes nodes, each on its axis, with small classes folded away. */
function failureClasses(rows: Awaited<ReturnType<typeof failureGroups>>, inScope: ReadonlySet<string>, min: number): FailureGroupOut[] {
	const known = (row: (typeof rows)[number]): { axis: FailureGroupOut["axis"]; classId: string } => {
		const axis = row.axis === "turn" || row.axis === "tool" || row.axis === "child" ? row.axis : "other";
		const classId = row.classId === UNCLASSIFIED.classId || (row.classId !== null && failureClass(row.classId) !== undefined) ? row.classId : "other";
		return { axis, classId: classId ?? "other" };
	};
	const groups = group(
		rows.filter((r) => inScope.has(r.id)),
		(r) => `${known(r).axis}:${known(r).classId}`,
		(r) => r.count,
	);
	// A class folds into `other` on its own axis, so the axis never goes missing.
	const folded = guardGroups(groups, min);
	return ordered(folded).map((g) => {
		const [axis, ...rest] = g.key.split(":");
		return { axis: (g.key === "other" ? "other" : axis) as FailureGroupOut["axis"], classId: g.key === "other" ? "other" : rest.join(":"), count: g.count, sessions: g.sessions };
	});
}

/** Build the fingerprint for a request. */
export async function buildFingerprint(db: AsyncDatabase, request: FingerprintRequest): Promise<Fingerprint> {
	const scope = toScope(request);
	const min = MIN_GROUP_SIZE;
	const sessions = await sessionFacts(db, scope);
	const inScope = new Set(sessions.map((s) => s.id));

	const bySource = ordered(
		guardGroups(
			group(
				sessions,
				(s): SourceGroup => (SOURCE_GROUPS as readonly string[]).includes(s.source) ? (s.source as SourceGroup) : "unknown",
				() => 1,
			),
			min,
		),
	);

	const startDays = new Set(sessions.flatMap((s) => (s.startedAt === null ? [] : [utcDay(s.startedAt)])));
	const durations = sessions.flatMap((s) => minutesBetween(s.firstTimestamp, s.lastTimestamp) ?? []);
	const withSubAgents = sessions.filter((s) => s.subAgentSessions > 0);
	const subAgentSessions = withSubAgents.reduce((n, s) => n + s.subAgentSessions, 0);
	const corpusBigEnough = sessions.length >= min;

	const active = (await activeSeconds(db, scope)).filter((r) => inScope.has(r.id) && typeof r.seconds === "number");
	const activeMinutes = active.map((r) => Math.round((r.seconds / 60) * 100) / 100);
	const activeTime: Fingerprint["objective"]["usage"]["activeTime"] =
		active.length < min
			? WITHHELD
			: {
					status: "ok",
					sessionsMeasured: active.length,
					totalHours: Math.round((active.reduce((n, r) => n + r.seconds, 0) / 3600) * 10) / 10,
					distribution: distribution(activeMinutes, DURATION_EDGES_MINUTES, "minutes", min),
				};

	const failureNodes = (await failureTotals(db, scope)).filter((r) => inScope.has(r.id));
	const failures: Fingerprint["objective"]["failures"] =
		failureNodes.length < min
			? WITHHELD
			: {
					status: "ok",
					sessionsMeasured: failureNodes.length,
					turnFailures: failureNodes.reduce((n, r) => n + r.turnFailures, 0),
					toolFailures: failureNodes.reduce((n, r) => n + r.toolFailures, 0),
					byClass: failureClasses(await failureGroups(db, scope), inScope, min),
				};

	const frustrationMeasured = [...(await sessionsWithRun(db, scope, "turn-frustration"))].filter((id) => inScope.has(id));
	const frustration: Fingerprint["inferred"]["frustration"] =
		frustrationMeasured.length < min
			? WITHHELD
			: await (async () => {
					const hits = (await frustrationHits(db, scope)).filter((h) => inScope.has(h.id));
					// A hit with no origin label cannot be told from pasted text, so it counts for nothing.
					const groups = group(
						hits,
						(h) => (h.signalSource === "paralinguistic" ? "paralinguistic" : member(FRUSTRATION_CATEGORIES, h.category)),
						(h) => h.typed ?? 0,
					);
					return {
						status: "ok" as const,
						sessionsMeasured: frustrationMeasured.length,
						signals: groups.reduce((n, g) => n + g.count, 0),
						byCategory: ordered(guardGroups(groups, min)),
					};
				})();

	const classifierRan = [...(await sessionsWithRun(db, scope, "turn-pair-llm"))].filter((id) => inScope.has(id));
	const turnClassification: Fingerprint["inferred"]["turnClassification"] =
		classifierRan.length < min
			? WITHHELD
			: await (async () => {
					const rows = (await turnClassifications(db, scope)).filter((r) => inScope.has(r.id));
					return {
						status: "ok" as const,
						sessionsMeasured: classifierRan.length,
						turnsClassified: rows.length,
						frictionType: ordered(guardGroups(group(rows, (r) => member(FRICTION_TYPES, r.frictionType), () => 1), min)),
						sentiment: ordered(guardGroups(group(rows, (r) => member(SENTIMENTS, r.sentiment), () => 1), min)),
					};
				})();

	return {
		schemaVersion: FINGERPRINT_SCHEMA_VERSION,
		kind: "corpus-fingerprint",
		asOf: utcDay(request.asOf),
		filter: { sources: request.sources, from: request.from, to: request.to },
		minGroupSize: MIN_GROUP_SIZE,
		sessions: { count: sessions.length, bySource: corpusBigEnough ? (bySource as Fingerprint["sessions"]["bySource"]) : [] },
		objective: {
			usage: {
				activeDays: corpusBigEnough ? startDays.size : WITHHELD,
				duration: distribution(durations, DURATION_EDGES_MINUTES, "minutes", min),
				activeTime,
			},
			shape: {
				promptsPerSession: distribution(sessions.map((s) => s.prompts), PROMPT_EDGES, "prompts", min),
				toolCallsPerSession: distribution(sessions.map((s) => s.toolCalls), TOOL_CALL_EDGES, "tool-calls", min),
				subAgents:
					withSubAgents.length === 0 && corpusBigEnough
						? { status: "ok", sessionsWithSubAgents: 0, subAgentSessions: 0 }
						: withSubAgents.length >= min
							? { status: "ok", sessionsWithSubAgents: withSubAgents.length, subAgentSessions }
							: WITHHELD,
			},
			failures,
		},
		inferred: { frustration, turnClassification },
	};
}
