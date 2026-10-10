import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Check } from "typebox/value";
import { openAsyncDatabase, type AsyncDatabase } from "../../src/db/async-db.js";
import { migrate } from "../../src/db/schema.js";
import { acceptProposal, rejectProposal } from "../../src/db/queries.js";
import { UsagePayload } from "../../src/telemetry/schema.js";
import { buildPayload, sendDailyReport } from "../../src/telemetry/report.js";
import { readState, writeState } from "../../src/telemetry/state.js";

/**
 * The daily usage report (#290), built from a real prospector database: what
 * it counts, what it leaves out, and when the send cursor moves.
 */

const SESSION_ID = "session-telemetry-1";
const SECRET_TITLE = "Stop editing the deploy script in /home/someone/private";
let dir: string;
let db: AsyncDatabase;
let env: NodeJS.ProcessEnv;
const ALL_TIME = { since: "1970-01-01T00:00:00.000Z", until: "2100-01-01T00:00:00.000Z" };

before(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "prospector-telemetry-db-"));
	db = openAsyncDatabase(path.join(dir, "p.db"));
	await migrate(db);
	const run = (sql: string, ...params: unknown[]) => db.prepare(sql).run(...params);
	await run("INSERT INTO sessions (id, file_path, source) VALUES (?, ?, 'claude')", SESSION_ID, "/home/someone/private/s.jsonl");
	await run(
		`INSERT INTO analysis_runs (id, analyzer_id, analyzer_version_id, config_id, session_id, status, started_at, finished_at, nodes_produced)
		 VALUES ('r1', 'session-overview', 'v1', 'c1', ?, 'ok', '2026-10-08T10:00:00.000Z', '2026-10-08T10:00:30.000Z', 2),
		        ('r2', 'session-overview', 'v1', 'c1', ?, 'error', '2026-10-08T11:00:00.000Z', NULL, 0),
		        ('r3', 'my-private-analyzer', 'v1', 'c1', ?, 'ok', '2026-10-08T12:00:00.000Z', '2026-10-08T12:00:01.000Z', 1)`,
		SESSION_ID,
		SESSION_ID,
		SESSION_ID,
	);
	for (const [id, severity] of [
		["p1", "friction"],
		["p2", "waste"],
	] as const) {
		await run(
			`INSERT INTO proposals (id, created_at, updated_at, session_id, analyzer_id, target_type, title, severity, summary, input_key)
			 VALUES (?, '2026-10-08T10:00:31.000Z', '2026-10-08T10:00:31.000Z', ?, 'session-overview', 'agents_md', ?, ?, 'summary', ?)`,
			id,
			SESSION_ID,
			SECRET_TITLE,
			severity,
			`key-${id}`,
		);
	}
	await acceptProposal(db, "p1");
	await rejectProposal(db, "p2");
});

after(async () => {
	await db.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	env = { PROSPECTOR_TELEMETRY_FILE: path.join(dir, "telemetry.json") };
	fs.rmSync(env["PROSPECTOR_TELEMETRY_FILE"]!, { force: true });
});

describe("buildPayload", () => {
	it("counts runs, proposals, and decisions per analyzer and harness", async () => {
		const payload = await buildPayload(db, { installId: "0b5e8c1e-6f0a-4d43-9a7e-3f1d2c4b5a69" }, ALL_TIME);
		assert.ok(Check(UsagePayload, payload));
		const overview = payload.rows.find((r) => r.analyzer === "session-overview");
		assert.deepEqual(overview, {
			analyzer: "session-overview",
			harness: "claude",
			runs: 2,
			runsFailed: 1,
			sessions: 1,
			nodes: 2,
			durationSec: 30,
			proposals: 2,
			friction: 1,
			correction: 0,
			waste: 1,
			suggestion: 0,
			reinforcement: 0,
			accepted: 1,
			rejected: 1,
			acceptedModified: 0,
		});
	});

	it("reports a locally authored analyzer as custom, never by its id", async () => {
		const payload = await buildPayload(db, { installId: "0b5e8c1e-6f0a-4d43-9a7e-3f1d2c4b5a69" }, ALL_TIME);
		assert.deepEqual(
			payload.rows.map((r) => r.analyzer),
			["custom", "session-overview"],
		);
		const text = JSON.stringify(payload);
		for (const forbidden of ["my-private-analyzer", SESSION_ID, SECRET_TITLE, "/home/someone", "agents_md", "key-p1"]) {
			assert.ok(!text.includes(forbidden), `payload contains ${forbidden}`);
		}
	});

	it("counts nothing outside the window", async () => {
		const payload = await buildPayload(db, { installId: "0b5e8c1e-6f0a-4d43-9a7e-3f1d2c4b5a69" }, { since: "2026-10-08T12:00:00.000Z", until: ALL_TIME.until });
		const overview = payload.rows.find((r) => r.analyzer === "session-overview");
		assert.equal(overview?.runs ?? 0, 0);
	});
});

describe("sendDailyReport", () => {
	const now = new Date("2026-10-09T09:00:00Z");
	const grant = () =>
		writeState(
			{ installId: "0b5e8c1e-6f0a-4d43-9a7e-3f1d2c4b5a69", consent: "granted", consentAt: "2026-10-01T00:00:00.000Z" },
			env["PROSPECTOR_TELEMETRY_FILE"],
		);

	it("sends nothing until the user says yes", async () => {
		let called = false;
		const result = await sendDailyReport({ db: async () => db, env, now, fetch: async () => ((called = true), new Response(null, { status: 204 })) });
		assert.equal(result, "not-due");
		assert.equal(called, false);
	});

	it("posts the report once, then waits for the next UTC day", async () => {
		grant();
		const bodies: unknown[] = [];
		const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)));
			return new Response(null, { status: 204 });
		};
		assert.equal(await sendDailyReport({ db: async () => db, env, now, fetch }), "sent");
		assert.equal(bodies.length, 1);
		assert.ok(Check(UsagePayload, bodies[0]));
		const state = readState(env["PROSPECTOR_TELEMETRY_FILE"]);
		assert.equal(state.lastSentDay, "2026-10-09");
		assert.equal(state.sentThrough, now.toISOString());
		assert.equal(await sendDailyReport({ db: async () => db, env, now, fetch }), "not-due");
		assert.equal(bodies.length, 1);
	});

	it("leaves the day open when there is nothing to report", async () => {
		writeState(
			{ installId: "0b5e8c1e-6f0a-4d43-9a7e-3f1d2c4b5a69", consent: "granted", sentThrough: "2099-01-01T00:00:00.000Z" },
			env["PROSPECTOR_TELEMETRY_FILE"],
		);
		const result = await sendDailyReport({ db: async () => db, env, now, fetch: async () => assert.fail("sent") });
		assert.equal(result, "empty");
		assert.equal(readState(env["PROSPECTOR_TELEMETRY_FILE"]).lastSentDay, undefined);
	});

	it("keeps the cursor when the Worker refuses the report", async () => {
		grant();
		const result = await sendDailyReport({ db: async () => db, env, now, fetch: async () => new Response(null, { status: 429 }) });
		assert.deepEqual(result, { failed: "HTTP 429" });
		assert.equal(readState(env["PROSPECTOR_TELEMETRY_FILE"]).lastSentDay, undefined);
	});

	it("prints the report instead of sending it under PROSPECTOR_TELEMETRY_DEBUG", async () => {
		grant();
		const printed: string[] = [];
		let called = false;
		const result = await sendDailyReport({
			db: async () => db,
			env: { ...env, PROSPECTOR_TELEMETRY_DEBUG: "1" },
			now,
			fetch: async () => ((called = true), new Response(null, { status: 204 })),
			debug: (line) => printed.push(line),
		});
		assert.equal(result, "debug");
		assert.equal(called, false);
		assert.ok(Check(UsagePayload, JSON.parse(printed.join("\n"))));
	});

	it("sends nothing under DO_NOT_TRACK, even with consent", async () => {
		grant();
		const result = await sendDailyReport({ db: async () => db, env: { ...env, DO_NOT_TRACK: "1" }, now, fetch: async () => assert.fail("sent") });
		assert.equal(result, "not-due");
	});
});
