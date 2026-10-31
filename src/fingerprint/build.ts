import { Check, Errors } from "typebox/value";
import type { AsyncDatabase } from "../db/async-db.js";
import { currentNodeItems, currentNodeRows, sessionFacts, sessionsWithRun, type FingerprintScope } from "../db/fingerprint-queries.js";
import { HARNESS_SOURCES, isHarnessSource, type HarnessSource } from "../harness.js";
import { parseTimestamp } from "../timepoint.js";
import type { FingerprintContributor, FingerprintReadContext, FingerprintRow, MeasureSpec } from "./contributor.js";
import { distribution, guardGroups, WITHHELD, type RawGroup } from "./guard.js";
import { FINGERPRINT_SCHEMA_VERSION, fingerprintSchema, MIN_GROUP_SIZE, type Fingerprint } from "./schema.js";

/**
 * Derive a corpus fingerprint from the session index and the analysis graph.
 * The builder knows no section by name: it asks each registered contributor for
 * rows, applies the minimum group size to every measure, and checks the result
 * against the schema the contributors' declarations compose. The derivation is
 * a read: it creates no node, run, edge, or proposal, and a second call with the
 * same arguments gives the same answer.
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
	/** Where to write the output; stdout when absent. */
	out?: string;
	/** The renderer id; the default renderer when absent. */
	format?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(flag: string, value: string | undefined): string | null {
	if (value === undefined) return null;
	if (!DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new Error(`--${flag} takes a date as YYYY-MM-DD, got '${value}'`);
	return value;
}

/**
 * Parse `--source a,b` (repeatable), `--from DAY`, `--to DAY`, `--as-of DAY|ISO|7d`,
 * `--format ID` and `--out FILE`. With no arguments the request takes everything, as of `now`.
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
		else if (name === "from" || name === "to" || name === "as-of" || name === "out" || name === "format") flags[name] = value;
		else throw new Error(`unknown flag --${name} (use --source, --from, --to, --as-of, --format, --out)`);
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
	return { sources: chosen.length > 0 ? [...new Set(chosen)] : null, from, to, asOf, out: flags["out"], format: flags["format"] };
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

/** Separates the values of a group's dimensions inside its key; no dimension value can contain it. */
const SEP = "\u0000";

function numberOf(row: FingerprintRow, field: string): number | null {
	const value = row[field];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(n: number, decimals: number): number {
	const f = 10 ** decimals;
	return Math.round(n * f) / f;
}

/** Order groups largest first, then by key, so equal inputs always print the same. */
function byCountThenKey<T extends { key: string; count: number }>(groups: T[]): T[] {
	return [...groups].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** One measure's value over a section's rows. The minimum group size is applied here, for every contributor. */
function applyMeasure(measure: MeasureSpec, rows: readonly FingerprintRow[], min: number): unknown {
	switch (measure.kind) {
		case "distribution": {
			const values = rows.flatMap((r) => numberOf(r, measure.field) ?? []);
			return distribution(values, measure.edges, measure.unit, min);
		}
		case "total": {
			const contributing = new Set<string>();
			let sum = 0;
			for (const row of rows) {
				const value = numberOf(row, measure.field);
				if (value === null || value === 0) continue;
				sum += value;
				contributing.add(String(row["session"]));
			}
			if (contributing.size > 0 && contributing.size < min) return WITHHELD;
			return round(sum / (measure.divisor ?? 1), measure.decimals ?? 0);
		}
		case "sessions": {
			const ids = new Set(rows.filter((r) => (numberOf(r, measure.field) ?? 0) > 0).map((r) => String(r["session"])));
			return ids.size > 0 && ids.size < min ? WITHHELD : ids.size;
		}
		case "distinct": {
			const values = new Set<string>();
			const contributing = new Set<string>();
			for (const row of rows) {
				const value = row[measure.field];
				if (typeof value !== "string") continue;
				values.add(value);
				contributing.add(String(row["session"]));
			}
			return contributing.size > 0 && contributing.size < min ? WITHHELD : values.size;
		}
		case "groups": {
			const names = Object.keys(measure.dimensions);
			const groups = new Map<string, { count: number; ids: Set<string> }>();
			for (const row of rows) {
				const values: string[] = [];
				for (const name of names) {
					const value = row[name];
					if (typeof value !== "string") break;
					values.push(measure.dimensions[name]!.includes(value) ? value : "other");
				}
				if (values.length !== names.length) continue;
				const count = measure.countField === undefined ? 1 : (numberOf(row, measure.countField) ?? 0);
				if (count <= 0) continue;
				const key = values.join(SEP);
				const entry = groups.get(key) ?? { count: 0, ids: new Set<string>() };
				entry.count += count;
				entry.ids.add(String(row["session"]));
				groups.set(key, entry);
			}
			const raw: Array<RawGroup<string>> = [...groups].map(([key, g]) => ({ key, count: g.count, sessionIds: g.ids }));
			const otherKey = names.map(() => "other").join(SEP);
			return byCountThenKey(guardGroups(raw, min, otherKey)).map((g) => ({
				...Object.fromEntries(g.key.split(SEP).map((value, i) => [names[i]!, value])),
				count: g.count,
				sessions: g.sessions,
			}));
		}
	}
}

/** The section of one contributor: withheld when it covers fewer sessions than the minimum. */
async function buildSection(contributor: FingerprintContributor, ctx: FingerprintReadContext, inScope: ReadonlySet<string>, min: number): Promise<unknown> {
	const read = await contributor.read(ctx);
	const measured = new Set(read.measured.filter((id) => inScope.has(id)));
	if (measured.size < min) return WITHHELD;
	const rows = read.rows.filter((r) => typeof r["session"] === "string" && inScope.has(r["session"]));
	return {
		status: "ok",
		sessionsMeasured: measured.size,
		...Object.fromEntries(contributor.def.measures.map((m) => [m.id, applyMeasure(m, rows, min)])),
	};
}

function utcDay(iso: string): string {
	return iso.slice(0, 10);
}

/**
 * Build the fingerprint for a request from the given contributors. Throws if
 * the result does not match the schema those contributors compose, which would
 * mean a contributor produced a value it did not declare.
 */
export async function buildFingerprint(db: AsyncDatabase, request: FingerprintRequest, contributors: readonly FingerprintContributor[]): Promise<Fingerprint> {
	const scope = toScope(request);
	const min = MIN_GROUP_SIZE;
	const sessions = await sessionFacts(db, scope);
	const inScope = new Set(sessions.map((s) => s.id));
	const ctx: FingerprintReadContext = {
		scope,
		sessions,
		runs: async (analyzerId) => [...(await sessionsWithRun(db, scope, analyzerId))],
		nodes: (analyzerId, fields) => currentNodeRows(db, scope, analyzerId, fields),
		items: (analyzerId, arrayPath, itemFields, nodeFields) => currentNodeItems(db, scope, analyzerId, arrayPath, itemFields, nodeFields),
	};
	const section = async (kind: "objective" | "inferred") =>
		Object.fromEntries(
			await Promise.all(
				contributors.filter((c) => c.def.kind === kind).map(async (c) => [c.def.id, await buildSection(c, ctx, inScope, min)] as const),
			),
		);
	const fingerprint = {
		schemaVersion: FINGERPRINT_SCHEMA_VERSION,
		kind: "corpus-fingerprint",
		asOf: utcDay(request.asOf),
		filter: { sources: request.sources, from: request.from, to: request.to },
		minGroupSize: MIN_GROUP_SIZE,
		sessions: { count: sessions.length },
		objective: await section("objective"),
		inferred: await section("inferred"),
	};
	const schema = fingerprintSchema(contributors);
	if (!Check(schema, fingerprint)) {
		const first = [...Errors(schema, fingerprint)][0];
		throw new Error(`the fingerprint does not match its schema${first ? ` at ${first.instancePath || "/"}: ${first.message}` : ""}`);
	}
	return fingerprint as Fingerprint;
}
