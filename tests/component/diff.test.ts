import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/schema.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM, type MockLLMReply } from "../../src/analyze/mock-llm.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import type { LLMRequest } from "../../src/analyze/types.js";
import { prospectDiff } from "../../src/commands/diff.js";
import { prospectRuns } from "../../src/commands/runs.js";

let tmpDir: string;
let dbPath: string;
before(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prospector-diff-"));
	dbPath = path.join(tmpDir, "diff.db");
	process.env["PROSPECTOR_DB_PATH"] = dbPath;
	process.env["PROSPECTOR_SESSIONS_DIR"] = path.resolve(import.meta.dirname, "..", "fixtures");
});
after(() => {
	delete process.env["PROSPECTOR_DB_PATH"];
	delete process.env["PROSPECTOR_SESSIONS_DIR"];
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

const notes: string[] = [];
const fakeCtx = {
	hasUI: false,
	modelRegistry: {} as never,
	ui: { notify: (m: string) => notes.push(m) },
} as never;

function respond(_req: LLMRequest): MockLLMReply {
	return { text: "x", structured: {}, costUsd: 0, tokensUsed: 0 };
}

async function runDiff(args: string): Promise<string> {
	notes.length = 0;
	await prospectDiff(args, fakeCtx as never);
	return notes.join("\n");
}

/** Build a turn-pair-core graph, then re-run with a major version bump to create a revises chain. */
async function buildTwoVersionGraph(): Promise<{ sessionId: string; sourceSetHash: string }> {
	const db = new Database(dbPath);
	migrate(db);
	const { insertSession, insertMessages } = await import("./helpers.js");
	insertSession(db, "sess-diff");
	insertMessages(db, "sess-diff", [
		{ role: "user", text: "do a thing" },
		{ role: "assistant", text: "done" },
	]);
	const mock = createMockLLM({ responder: respond });
	const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
	fw.register(turnPairCoreAnalyzer);
	await fw.run("sess-diff", {});

	const sset = (db
		.prepare("SELECT source_set_hash FROM analysis_nodes WHERE analyzer_id = 'turn-pair-core' AND session_id = ? LIMIT 1")
		.get("sess-diff") as { source_set_hash: string }).source_set_hash;

	const fw2 = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
	fw2.register({ ...turnPairCoreAnalyzer, version: { ...turnPairCoreAnalyzer.version, major: 2 } });
	await fw2.run("sess-diff", { revise: ["major"], analyzerIds: ["turn-pair-core"] });
	db.close();
	return { sessionId: "sess-diff", sourceSetHash: sset };
}

describe("prospect diff (#53)", () => {
	it("diff --unit reports a recipe change across the revises chain", async () => {
		const { sourceSetHash } = await buildTwoVersionGraph();
		const out = await runDiff(`--unit turn-pair-core ${sourceSetHash} --full`);
		assert.match(out, /recipe changed \((analyzer-version|config|source-set)/);
	});

	it("diff --as-of reports the unit as changed between two timepoints", async () => {
		// Build the first version and capture its time, then bump the version.
		const db = new Database(dbPath);
		migrate(db);
		const { insertSession, insertMessages } = await import("./helpers.js");
		insertSession(db, "sess-ts");
		insertMessages(db, "sess-ts", [
			{ role: "user", text: "zz" },
			{ role: "assistant", text: "ok" },
		]);
		const mock = createMockLLM({ responder: respond });
		const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
		fw.register(turnPairCoreAnalyzer);
		await fw.run("sess-ts", {});
		db.close();

		const before = new Date().toISOString();
		const db2 = new Database(dbPath);
		migrate(db2);
		const fw2 = new AnalyzerFramework({ db: db2, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
		fw2.register({ ...turnPairCoreAnalyzer, version: { ...turnPairCoreAnalyzer.version, major: 2 } });
		await fw2.run("sess-ts", { revise: ["major"], analyzerIds: ["turn-pair-core"] });
		db2.close();

		// The future timepoint (well after the v2 node) → the unit's latest changed.
		const future = "2038-01-01T00:00:00.000Z";
		const out = await runDiff(`--as-of ${before} ${future}`);
		assert.match(out, /changed/);
		assert.match(out, /turn-pair-core/);
	});

	it("prospect runs lists runs for discoverability", async () => {
		notes.length = 0;
		await prospectRuns("", fakeCtx as never);
		const out = notes.join("\n");
		assert.match(out, /Recent runs/);
		assert.match(out, /turn-pair-core/);
	});

	it("diff requires a mode", async () => {
		const out = await runDiff("");
		assert.match(out, /Usage: prospect diff --unit/);
	});
});
