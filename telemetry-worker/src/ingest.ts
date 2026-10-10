import { Check } from "typebox/value";
import { COUNT_FIELDS, KNOWN_ANALYZER_IDS, MAX_BODY_BYTES, UsagePayload, type UsageRow } from "../../src/telemetry/schema.js";

/**
 * The usage-report endpoint (#290): `POST /v1/usage`.
 *
 * Anyone can call it, because the client's code is public. It stores nothing
 * that doesn't match the schema, decides the day itself, keeps one set of rows
 * per install per day, and stops writing once the day's total passes a cap
 * set under D1's free limit. It never stores the caller's IP address.
 */

/** Most rows the Worker writes in one UTC day, across every install. */
export const DAILY_ROW_CAP = 20_000;

/** The slice of D1's API the Worker uses, so tests can supply a fake. */
export interface D1Statement {
	bind(...values: unknown[]): D1Statement;
	first<T>(): Promise<T | null>;
}
export interface D1Like {
	prepare(sql: string): D1Statement;
	batch(statements: D1Statement[]): Promise<unknown>;
}
export interface Env {
	DB: D1Like;
}

const KNOWN = new Set<string>(KNOWN_ANALYZER_IDS);

export async function handle(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname !== "/v1/usage") return new Response(null, { status: 404 });
	if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });

	const body = await readCapped(request, MAX_BODY_BYTES);
	if (body === undefined) return new Response(null, { status: 413 });
	const rows = parseUsage(body);
	if (rows === undefined) return new Response(null, { status: 400 });

	const day = now.toISOString().slice(0, 10);
	const used = await env.DB.prepare("SELECT rows FROM daily_writes WHERE day = ?").bind(day).first<{ rows: number }>();
	if ((used?.rows ?? 0) + rows.rows.length > DAILY_ROW_CAP) return new Response(null, { status: 429 });

	const columns = ["day", "install_id", "version", "analyzer", "harness", ...COUNT_FIELDS.map(snake)];
	const insert = `INSERT INTO usage_daily (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
	await env.DB.batch([
		// A second report on the same day replaces the first.
		env.DB.prepare("DELETE FROM usage_daily WHERE day = ? AND install_id = ?").bind(day, rows.installId),
		...rows.rows.map((row) =>
			env.DB.prepare(insert).bind(day, rows.installId, rows.version, row.analyzer, row.harness, ...COUNT_FIELDS.map((field) => row[field])),
		),
		env.DB.prepare(
			"INSERT INTO daily_writes (day, rows) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET rows = rows + excluded.rows",
		).bind(day, rows.rows.length),
	]);
	return new Response(null, { status: 204 });
}

/**
 * Parse and check a request body. Returns undefined for anything that isn't a
 * valid payload. Analyzer ids the Worker doesn't know become `other`, and rows
 * that then share an analyzer and harness are summed.
 */
export function parseUsage(body: Uint8Array): UsagePayload | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(body));
	} catch {
		return undefined;
	}
	if (!Check(UsagePayload, parsed)) return undefined;
	const merged = new Map<string, UsageRow>();
	for (const row of parsed.rows) {
		const analyzer = KNOWN.has(row.analyzer) ? row.analyzer : "other";
		const key = `${analyzer}\u0000${row.harness}`;
		const existing = merged.get(key);
		if (!existing) merged.set(key, { ...row, analyzer });
		else for (const field of COUNT_FIELDS) existing[field] += row[field];
	}
	return { ...parsed, rows: [...merged.values()] };
}

/** Read at most `limit` bytes of the body, whatever `Content-Length` claims. Undefined when the body is larger. */
export async function readCapped(request: Request, limit: number): Promise<Uint8Array | undefined> {
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			return undefined;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function snake(field: string): string {
	return field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
