import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FIXTURES, NO_CLAUDE_DIR } from "./helpers.js";
import { prospectSync } from "../../src/commands/sync.js";
import { prospectAnalyze } from "../../src/commands/analyze.js";
import { openAsyncDatabase, type AsyncDatabase } from "../../src/db/async-db.js";
import type { ExtensionCommandContext, ModelRegistry } from "../../src/pi-stubs.js";

/**
 * A session that gains messages after it was analysed is analysed again by a
 * plain fill (no --revise). Filling only missing work is the design; a grown
 * session *has* missing work — the units its new messages add — so retiring it
 * from the unanalysed queue on its first clean run strands that work forever.
 *
 * token-units is deterministic and session-level: its source set folds the
 * message count and the last message id, so a grown session presents exactly
 * one new unit.
 */

const notes: string[] = [];
const modelRegistry: ModelRegistry = {
	find: () => undefined,
	getAll: () => [],
	getAvailable: () => [],
	getApiKeyAndHeaders: async () => ({ ok: false, error: "no creds in test" }),
};
const ctx: ExtensionCommandContext = { modelRegistry, hasUI: false, ui: { notify: (m) => notes.push(m) } };

const ENV = ["PROSPECTOR_CONFIG", "PROSPECTOR_DB_PATH", "PROSPECTOR_SESSIONS_DIR", "PROSPECTOR_CLAUDE_SESSIONS_DIR", "PROSPECTOR_ANALYZERS_DIR"];
let tmpDir: string;
let sessionsDir: string;
let configFile: string;
let sessionFile: string;

const SESSION_ID = "aaaa0001-bbbb-cccc-dddd-eeeeeeeeeeee";

async function run(fn: (args: string, ctx: ExtensionCommandContext) => Promise<void>, args = ""): Promise<string> {
	notes.length = 0;
	const log = console.log;
	console.log = () => {};
	try {
		await fn(args, ctx);
	} finally {
		console.log = log;
	}
	return notes.join("\n");
}

async function withDb<T>(fn: (db: AsyncDatabase) => Promise<T>): Promise<T> {
	const db = openAsyncDatabase(process.env["PROSPECTOR_DB_PATH"]!);
	try {
		return await fn(db);
	} finally {
		await db.close();
	}
}

/** How many clean runs of token-units the session has recorded. */
async function runsForSession(): Promise<number> {
	return withDb(async (db) => {
		const row = (await db
			.prepare("SELECT COUNT(*) AS n FROM analysis_runs WHERE analyzer_id = 'token-units' AND session_id = ? AND status = 'ok'")
			.get(SESSION_ID)) as { n: number };
		return row.n;
	});
}

async function liveNodes(): Promise<number> {
	return withDb(async (db) => {
		const row = (await db
			.prepare("SELECT COUNT(*) AS n FROM live_nodes WHERE analyzer_id = 'token-units' AND session_id = ?")
			.get(SESSION_ID)) as { n: number };
		return row.n;
	});
}

/** Append one more turn to the session on disk, the way a live session grows. */
function appendMessage(text: string): void {
	const line = {
		type: "message",
		id: `grow-${fs.readFileSync(sessionFile, "utf8").length}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: [{ type: "text", text }] },
	};
	// The fixture may lack a trailing newline; appending into its last line would
	// corrupt it, which a real transcript (always newline-terminated) never does.
	const current = fs.readFileSync(sessionFile, "utf8");
	fs.appendFileSync(sessionFile, (current.endsWith("\n") ? "" : "\n") + JSON.stringify(line) + "\n");
}

before(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prospector-grow-"));
	sessionsDir = path.join(tmpDir, "sessions");
	// Copy one fixture session into a tree the test owns, so it can be grown.
	const project = path.join(sessionsDir, "--Users-test--project");
	fs.mkdirSync(project, { recursive: true });
	const fixture = path.join(FIXTURES, "--Users-test--project", `2026-01-15T10-00-00-000Z_${SESSION_ID}.jsonl`);
	sessionFile = path.join(project, path.basename(fixture));
	fs.copyFileSync(fixture, sessionFile);
	// Backdate the copy: sync skips a file whose mtime has not advanced, and a
	// copy plus an append inside one timestamp tick would look unchanged.
	const anHourAgo = new Date(Date.now() - 3600_000);
	fs.utimesSync(sessionFile, anHourAgo, anHourAgo);

	configFile = path.join(tmpDir, "prospector.json");
	fs.writeFileSync(configFile, JSON.stringify({ defaultAnalyzers: ["token-units"], disabledAnalyzers: [] }));
	process.env["PROSPECTOR_CONFIG"] = configFile;
	process.env["PROSPECTOR_DB_PATH"] = path.join(tmpDir, "grow.db");
	process.env["PROSPECTOR_SESSIONS_DIR"] = sessionsDir;
	process.env["PROSPECTOR_CLAUDE_SESSIONS_DIR"] = NO_CLAUDE_DIR;
	process.env["PROSPECTOR_ANALYZERS_DIR"] = path.join(tmpDir, "no-custom-analyzers");
	await run(prospectSync);
});

after(() => {
	for (const k of ENV) delete process.env[k];
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("a plain fill re-analyses a session that gained messages", () => {
	it("analyses the session once, then again after it grew", async () => {
		await run(prospectAnalyze);
		assert.equal(await runsForSession(), 1, "first fill analyses the session");
		assert.equal(await liveNodes(), 1);

		appendMessage("and also add a test for it");
		await run(prospectSync);
		const out = await run(prospectAnalyze);
		assert.match(out, /0 failed/);

		assert.equal(await runsForSession(), 2, "the grown session is analysed again");
		assert.equal(await liveNodes(), 2, "its new turn earns its own node");
	});

	it("re-scans a session analysed before the covered count was recorded", async () => {
		// A database upgraded from before this column: analysed, coverage unknown.
		// Unknown coverage must not read as covered, or the work its later messages
		// added stays stranded.
		await withDb(async (db) => {
			await db.prepare("UPDATE sessions SET analyzed_message_count = NULL WHERE id = ?").run(SESSION_ID);
		});
		const runsBefore = await runsForSession();
		const out = await run(prospectAnalyze);
		assert.match(out, /0 failed/);
		assert.equal(await runsForSession(), runsBefore + 1, "unknown coverage is revisited once");
		const recorded = await withDb(async (db) =>
			(await db.prepare("SELECT analyzed_message_count AS n FROM sessions WHERE id = ?").get(SESSION_ID)) as { n: number },
		);
		assert.equal(recorded.n, 5, "the run records what it covered");
	});

	it("leaves an unchanged session alone on the next fill", async () => {
		const before = { runs: await runsForSession(), nodes: await liveNodes() };
		await run(prospectSync);
		await run(prospectAnalyze);
		assert.deepEqual({ runs: await runsForSession(), nodes: await liveNodes() }, before, "no growth, no re-run");
	});
});
