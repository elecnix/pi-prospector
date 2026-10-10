import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { BUILTIN_ANALYZERS } from "../../src/analyze/defaults.js";
import { KNOWN_ANALYZER_IDS, MAX_BODY_BYTES, type UsagePayload, type UsageRow } from "../../src/telemetry/schema.js";
import { DAILY_ROW_CAP, handle, parseUsage, type D1Like, type D1Statement } from "../../telemetry-worker/src/ingest.js";

/**
 * The usage-report Worker (#290), run against a real SQLite database with the
 * Worker's own D1 migration applied, so the CHECK constraints are the real ones.
 */

const MIGRATION = path.resolve(import.meta.dirname, "..", "..", "telemetry-worker", "migrations", "0001_usage.sql");
const NOW = new Date("2026-10-09T12:00:00Z");
const INSTALL = "0b5e8c1e-6f0a-4d43-9a7e-3f1d2c4b5a69";

function row(overrides: Partial<UsageRow> = {}): UsageRow {
	return {
		analyzer: "session-overview",
		harness: "pi",
		runs: 3,
		runsFailed: 0,
		sessions: 3,
		nodes: 6,
		durationSec: 40,
		proposals: 2,
		friction: 1,
		correction: 0,
		waste: 1,
		suggestion: 0,
		reinforcement: 0,
		accepted: 1,
		rejected: 1,
		acceptedModified: 0,
		...overrides,
	};
}

function payload(overrides: Partial<UsagePayload> = {}): UsagePayload {
	return { schema: 1, installId: INSTALL, version: "0.3.0", rows: [row()], ...overrides };
}

function bytes(value: unknown): Uint8Array {
	return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
}

/** D1's API over better-sqlite3. */
function fakeD1(db: Database.Database): D1Like {
	const statement = (sql: string, values: unknown[] = []): D1Statement & { run(): void } => ({
		bind: (...next: unknown[]) => statement(sql, next),
		first: async <T>() => (db.prepare(sql).get(...values) as T | undefined) ?? null,
		run: () => void db.prepare(sql).run(...values),
	});
	return {
		prepare: (sql) => statement(sql),
		batch: async (statements) => db.transaction(() => statements.forEach((s) => (s as ReturnType<typeof statement>).run()))(),
	};
}

function post(body: unknown): Request {
	return new Request("https://telemetry.test/v1/usage", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
}

describe("usage-report schema (#290)", () => {
	it("names every built-in analyzer, plus custom and other", () => {
		const known = new Set<string>(KNOWN_ANALYZER_IDS);
		for (const analyzer of BUILTIN_ANALYZERS) assert.ok(known.has(analyzer.def.id), `${analyzer.def.id} is missing from KNOWN_ANALYZER_IDS`);
		assert.ok(known.has("custom") && known.has("other"));
	});
});

describe("parseUsage", () => {
	it("accepts a valid payload", () => {
		assert.deepEqual(parseUsage(bytes(payload())), payload());
	});

	it("rejects unknown fields, at the top level and in a row", () => {
		assert.equal(parseUsage(bytes({ ...payload(), note: "hello" })), undefined);
		assert.equal(parseUsage(bytes(payload({ rows: [{ ...row(), title: "a proposal title" } as UsageRow] }))), undefined);
	});

	it("rejects values outside the fixed lists and ranges", () => {
		assert.equal(parseUsage(bytes(payload({ rows: [row({ harness: "codex" as "pi" })] }))), undefined);
		assert.equal(parseUsage(bytes(payload({ rows: [row({ runs: -1 })] }))), undefined);
		assert.equal(parseUsage(bytes(payload({ rows: [row({ runs: 1.5 })] }))), undefined);
		assert.equal(parseUsage(bytes(payload({ rows: [row({ analyzer: "Free text with spaces" })] }))), undefined);
		assert.equal(parseUsage(bytes(payload({ installId: "not-a-uuid" }))), undefined);
		assert.equal(parseUsage(bytes(payload({ version: "1.0.0; drop table" }))), undefined);
		assert.equal(parseUsage(bytes("not json")), undefined);
	});

	it("stores an analyzer it doesn't know as other, summing rows that then collide", () => {
		const parsed = parseUsage(bytes(payload({ rows: [row({ analyzer: "future-one" }), row({ analyzer: "future-two" })] })));
		assert.deepEqual(parsed?.rows, [row({ analyzer: "other", runs: 6, sessions: 6, nodes: 12, durationSec: 80, proposals: 4, friction: 2, waste: 2, accepted: 2, rejected: 2 })]);
	});
});

describe("Worker POST /v1/usage", () => {
	let db: Database.Database;
	let env: { DB: D1Like };

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec(fs.readFileSync(MIGRATION, "utf-8"));
		env = { DB: fakeD1(db) };
	});

	it("stores the rows under the server's UTC day and answers 204", async () => {
		const response = await handle(post(payload()), env, NOW);
		assert.equal(response.status, 204);
		const stored = db.prepare("SELECT day, install_id, analyzer, harness, runs, accepted_modified FROM usage_daily").all();
		assert.deepEqual(stored, [{ day: "2026-10-09", install_id: INSTALL, analyzer: "session-overview", harness: "pi", runs: 3, accepted_modified: 0 }]);
	});

	it("replaces an install's earlier report for the same day", async () => {
		await handle(post(payload()), env, NOW);
		await handle(post(payload({ rows: [row({ runs: 9 })] })), env, NOW);
		assert.deepEqual(db.prepare("SELECT runs FROM usage_daily").all(), [{ runs: 9 }]);
	});

	it("rejects an invalid payload with 400 and stores nothing", async () => {
		const response = await handle(post({ ...payload(), extra: true }), env, NOW);
		assert.equal(response.status, 400);
		assert.equal(await response.text(), "");
		assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM usage_daily").get(), { n: 0 });
	});

	it("rejects a body over the cap by the bytes it reads, whatever Content-Length says", async () => {
		const big = JSON.stringify(payload()) + " ".repeat(MAX_BODY_BYTES);
		const request = new Request("https://telemetry.test/v1/usage", { method: "POST", body: big, headers: { "content-length": "10" } });
		assert.equal((await handle(request, env, NOW)).status, 413);
	});

	it("stops writing once the day's rows pass the cap", async () => {
		db.prepare("INSERT INTO daily_writes (day, rows) VALUES (?, ?)").run("2026-10-09", DAILY_ROW_CAP);
		assert.equal((await handle(post(payload()), env, NOW)).status, 429);
		assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM usage_daily").get(), { n: 0 });
	});

	it("answers 404 off the endpoint and 405 for other methods", async () => {
		assert.equal((await handle(new Request("https://telemetry.test/"), env, NOW)).status, 404);
		assert.equal((await handle(new Request("https://telemetry.test/v1/usage"), env, NOW)).status, 405);
	});
});
