import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerExtension from "../../src/index.js";
import { insertProposalRow } from "./helpers.js";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/schema.js";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ModelRegistry,
	ToolResult,
} from "../../src/pi-stubs.js";

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
type ToolExec = (
	id: string,
	params: Record<string, unknown>,
	signal: AbortSignal,
	onUpdate: unknown,
	ctx: ExtensionCommandContext,
) => Promise<ToolResult> | ToolResult;

const FIXTURES = path.resolve(import.meta.dirname, "..", "fixtures");

const commands = new Map<string, Handler>();
let toolExec: ToolExec;
const flags = new Map<string, string | boolean | undefined>();

const fakePi: ExtensionAPI = {
	registerCommand: (name, opts) => commands.set(name, opts.handler),
	registerTool: (tool) => {
		if (tool.name === "prospect") toolExec = tool.execute as ToolExec;
	},
	registerFlag: (name, opts) => {
		if (opts.default !== undefined) flags.set(name, opts.default);
	},
	getFlag: (name) => flags.get(name),
	on: () => {
		/* no session_start dispatch needed for these command tests */
	},
};

const notes: string[] = [];
const modelRegistry: ModelRegistry = {
	find: () => undefined,
	getAll: () => [],
	getAvailable: () => [],
	getApiKeyAndHeaders: async () => ({ ok: false, error: "no creds in test" }),
};
const ctx: ExtensionCommandContext = {
	modelRegistry,
	hasUI: false,
	ui: { notify: (m) => notes.push(m) },
};

let tmpDir: string;

before(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prospector-cmd-"));
	process.env["PROSPECTOR_DB_PATH"] = path.join(tmpDir, "cmd.db");
	process.env["PROSPECTOR_SESSIONS_DIR"] = FIXTURES;
	registerExtension(fakePi);
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

async function run(name: string, args = ""): Promise<string> {
	notes.length = 0;
	await commands.get(name)!(args, ctx);
	return notes.join("\n");
}

describe("slash commands", () => {
	it("registers all expected commands and the tool", () => {
		for (const name of [
			"prospect-sync",
			"prospect-stats",
			"prospect-proposals",
			"prospect-accept",
			"prospect-reject",
			"prospect-analyze",
		]) {
			assert.ok(commands.has(name), `missing command ${name}`);
		}
		assert.ok(typeof toolExec === "function");
	});

	it("prospect-sync indexes fixtures", async () => {
		const out = await run("prospect-sync");
		assert.match(out, /Prospect sync complete/);
		assert.match(out, /Sessions processed:/);
	});

	it("prospect-stats renders stats", async () => {
		const out = await run("prospect-stats");
		assert.match(out, /Prospector Stats/);
		assert.match(out, /Sessions indexed:/);
	});

	it("prospect-analyze runs the deterministic analyzer without an LLM", async () => {
		const out = await run("prospect-analyze", "--analyzer turn-pair-core");
		assert.match(out, /Done \[fill\]/);
		assert.match(out, /Nodes produced:/);
	});

	it("prospect-analyze --revise re-scans", async () => {
		const out = await run("prospect-analyze", "--revise all --analyzer turn-pair-core");
		assert.match(out, /Done \[revise:/);
	});

	it("prospect-analyze reports when there is nothing to do", async () => {
		// A fresh empty DB → no sessions.
		const emptyDb = path.join(tmpDir, "empty.db");
		process.env["PROSPECTOR_DB_PATH"] = emptyDb;
		try {
			const out = await run("prospect-analyze", "--session does-not-exist --analyzer turn-pair-core");
			assert.match(out, /Done|No sessions/);
		} finally {
			process.env["PROSPECTOR_DB_PATH"] = path.join(tmpDir, "cmd.db");
		}
	});

	it("prospect-proposals lists, accepts, and rejects", async () => {
		const db = new Database(process.env["PROSPECTOR_DB_PATH"]!);
		migrate(db);
		const session = db.prepare("SELECT id FROM sessions LIMIT 1").get() as { id: string };
		insertProposalRow(db, { id: "cmd-p1", sessionId: session.id, title: "Test proposal", severity: "friction" });
		insertProposalRow(db, { id: "cmd-p2", sessionId: session.id, title: "Second proposal", severity: "waste" });
		db.close();

		const list = await run("prospect-proposals");
		assert.match(list, /Test proposal/);

		const accepted = await run("prospect-accept", "cmd-p1");
		assert.match(accepted, /applied/);

		const rejected = await run("prospect-reject", "cmd-p2");
		assert.match(rejected, /rejected/);

		const filtered = await run("prospect-proposals", "applied");
		assert.match(filtered, /Test proposal/);

		const missing = await run("prospect-accept", "");
		assert.match(missing, /Usage/);

		const rejectMissing = await run("prospect-reject", "");
		assert.match(rejectMissing, /Usage/);
	});

	it("prospect-proposals reports empty state", async () => {
		process.env["PROSPECTOR_DB_PATH"] = path.join(tmpDir, "empty2.db");
		try {
			const out = await run("prospect-proposals");
			assert.match(out, /No proposals found/);
		} finally {
			process.env["PROSPECTOR_DB_PATH"] = path.join(tmpDir, "cmd.db");
		}
	});
});

describe("prospect tool", () => {
	const signal = new AbortController().signal;

	it("handles sync, stats, list_proposals, accept, reject, and unknown", async () => {
		const sync = await toolExec("t1", { action: "sync" }, signal, null, ctx);
		assert.match(sync.content[0]!.text, /sessionsProcessed/);

		const stats = await toolExec("t2", { action: "stats" }, signal, null, ctx);
		assert.match(stats.content[0]!.text, /totalSessions/);

		const list = await toolExec("t3", { action: "list_proposals" }, signal, null, ctx);
		assert.ok(list.content[0]!.text.length > 0);

		const acceptNoId = await toolExec("t4", { action: "accept" }, signal, null, ctx);
		assert.match(acceptNoId.content[0]!.text, /required/);

		const rejectNoId = await toolExec("t5", { action: "reject" }, signal, null, ctx);
		assert.match(rejectNoId.content[0]!.text, /required/);

		const unknown = await toolExec("t6", { action: "bogus" }, signal, null, ctx);
		assert.match(unknown.content[0]!.text, /Unknown action/);
	});
});
