import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FIXTURES } from "./helpers.js";
import { prospectSync } from "../../src/commands/sync.js";
import { prospectAnalyze } from "../../src/commands/analyze.js";
import { prospectAnalyzers } from "../../src/commands/analyzers.js";
import { coverageLines } from "../../src/commands/stats.js";
import { openAsyncDatabase, type AsyncDatabase } from "../../src/db/async-db.js";
import type { ExtensionCommandContext, ModelRegistry } from "../../src/pi-stubs.js";

/**
 * The default analyzer set (#291), driven through the real commands. The config
 * selects deterministic analyzers only, so a run that honours it never reaches
 * the model registry, which has no models here. A run that ignored the config
 * would select the LLM analyzers and fail on the first call.
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
let configFile: string;

function writeConfig(config: Record<string, unknown>): void {
	fs.writeFileSync(configFile, JSON.stringify(config));
}

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

async function ranAnalyzers(): Promise<string[]> {
	return withDb(async (db) => {
		const rows = (await db.prepare("SELECT DISTINCT analyzer_id FROM analysis_runs ORDER BY analyzer_id").all()) as Array<{
			analyzer_id: string;
		}>;
		return rows.map((r) => r.analyzer_id);
	});
}

before(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prospector-defaults-"));
	configFile = path.join(tmpDir, "prospector.json");
	process.env["PROSPECTOR_CONFIG"] = configFile;
	process.env["PROSPECTOR_DB_PATH"] = path.join(tmpDir, "defaults.db");
	process.env["PROSPECTOR_SESSIONS_DIR"] = FIXTURES;
	process.env["PROSPECTOR_CLAUDE_SESSIONS_DIR"] = path.join(tmpDir, "no-claude-sessions");
	process.env["PROSPECTOR_ANALYZERS_DIR"] = path.join(tmpDir, "no-custom-analyzers");
	writeConfig({});
	await run(prospectSync);
});

after(() => {
	for (const k of ENV) delete process.env[k];
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("default analyzer set (#291)", () => {
	it("an empty default set stops before marking any session analysed", async () => {
		writeConfig({ defaultAnalyzers: ["turn-pair-core"], disabledAnalyzers: ["turn-pair-core"] });
		const out = await run(prospectAnalyze);
		assert.match(out, /default analyzer set is empty/);
		const analysed = await withDb(async (db) => {
			const row = (await db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE analyzed_at IS NOT NULL").get()) as { n: number };
			return row.n;
		});
		assert.equal(analysed, 0);
		assert.deepEqual(await ranAnalyzers(), []);
	});

	it("a plain run selects the allowlist minus the denylist", async () => {
		writeConfig({
			defaultAnalyzers: ["turn-pair-core", "files-in-play", "session-ending"],
			disabledAnalyzers: ["session-ending"],
		});
		const out = await run(prospectAnalyze);
		assert.match(out, /0 failed/);
		assert.deepEqual(await ranAnalyzers(), ["files-in-play", "turn-pair-core"]);
	});

	it("--backfill-missing measures gaps against the default set only", async () => {
		const out = await run(prospectAnalyze, "--backfill-missing");
		assert.match(out, /No coverage gaps/);
		assert.deepEqual(await ranAnalyzers(), ["files-in-play", "turn-pair-core"]);
	});

	it("--analyzer runs an analyzer outside the default set", async () => {
		const out = await run(prospectAnalyze, "--analyzer session-ending --all");
		assert.match(out, /0 failed/);
		assert.deepEqual(await ranAnalyzers(), ["files-in-play", "session-ending", "turn-pair-core"]);
	});

	it("toggling the selection marks no node stale", async () => {
		writeConfig({ defaultAnalyzers: ["turn-pair-core", "files-in-play"], disabledAnalyzers: ["files-in-play"] });
		const out = await run(prospectAnalyze, "--all --revise all");
		assert.match(out, /Nodes produced: 0 \(revised: 0\)/);
	});

	it("warns about an id that matches no registered analyzer", async () => {
		writeConfig({ defaultAnalyzers: ["turn-pair-core", "turn-pair-cor"] });
		const out = await run(prospectAnalyze, "--all");
		assert.match(out, /turn-pair-cor/);
		assert.match(out, /0 failed/);
	});

	it("/prospect-analyzers list marks analyzers outside the default set", async () => {
		writeConfig({ disabledAnalyzers: ["session-ending"] });
		const out = await run(prospectAnalyzers, "list");
		assert.match(out, /session-ending .*off by default/);
		assert.doesNotMatch(out, /turn-pair-core .*off by default/);
	});

	it("stats coverage reports the default set and lists the rest on one line", async () => {
		writeConfig({ defaultAnalyzers: ["turn-pair-core", "files-in-play", "session-ending"] });
		const lines = await withDb((db) => coverageLines(db));
		const text = lines.join("\n");
		assert.match(text, /Every analyzer in the default set has run against every session|covered/);
		assert.doesNotMatch(text, /^\s+session-overview:/m);
		assert.match(text, /Off by default: .*session-overview/);
	});
});
