import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openAsyncDatabase } from "../../src/db/async-db.js";
import { migrate } from "../../src/db/schema.js";
import { insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { registerDefaults } from "../../src/analyze/defaults.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { listProposals } from "../../src/db/queries.js";
import { readSessionSummary, prospectShow } from "../../src/commands/show.js";
import type { LLMRequest } from "../../src/analyze/types.js";
import type { ExtensionCommandContext } from "../../src/pi-stubs.js";

function respond(req: LLMRequest): string {
	if (req.tool?.name === "classify_term") {
		return JSON.stringify({ polarity: "neutral", category: "none", language: "und", confidence: 0.9, rationale: "ordinary vocabulary" });
	}
	const sys = req.system ?? "";
	if (sys.includes("classify a single turn")) {
		return JSON.stringify({ sentiment: "frustrated", friction_type: "wrong_approach", is_genuine_correction: true, severity: "high", rationale: "corrected" });
	}
	if (sys.includes("summarise one segment")) return JSON.stringify({ segment_summary: "seg", notable_points: [] });
	return JSON.stringify({
		session_summary: "The session tried to fix a login bug and recovered after a correction.",
		friction_points: [{ description: "guessed the auth module path", what_to_change: "discover the path first", evidence: "user corrected in turn 2", severity: "high" }],
		key_positive_signals: [{ description: "clean recovery after the correction", signal: "correction-then-clean-recovery" }],
		improvement_proposals: [
			{ target_type: "agents_md", target_path: "AGENTS.md", title: "Document the auth module", summary: "s", detail: "d", evidence: "user corrected in turn 2", confidence: 0.7, severity: "correction" },
		],
	});
}

const notes: string[] = [];
const ctx: ExtensionCommandContext = {
	modelRegistry: { find: () => undefined, getAll: () => [], getAvailable: () => [], getApiKeyAndHeaders: async () => ({ ok: false, error: "x" }) },
	hasUI: false,
	ui: { notify: (m) => notes.push(m) },
};

let tmpDir: string;
let dbPath: string;

before(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prospector-session-summary-"));
	dbPath = path.join(tmpDir, "summary.db");
	process.env["PROSPECTOR_DB_PATH"] = dbPath;
	const db = openAsyncDatabase(dbPath);
	await migrate(db);
	await insertSession(db, "s1");
	await insertMessages(db, "s1", [
		{ id: "s1-m0", role: "user", text: "fix the login bug" },
		{ id: "s1-m1", role: "assistant", text: "reading auth", toolCalls: [{ name: "read" }] },
		{ id: "s1-m2", role: "toolResult", toolResults: [{ toolName: "read", isError: true, textLength: 40 }] },
		{ id: "s1-m3", role: "user", text: "no, that's wrong, use the auth module instead" },
		{ id: "s1-m4", role: "assistant", text: "understood" },
	]);
	const mock = createMockLLM({ responder: respond, tokensPerCall: 50, costPerCall: 0.001 });
	const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
	await registerDefaults(fw);
	const summary = await fw.run("s1", {});
	assert.equal(summary.errors.length, 0, summary.errors.join("; "));
	await db.close();
});

after(() => {
	delete process.env["PROSPECTOR_DB_PATH"];
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

async function show(args: string): Promise<string> {
	notes.length = 0;
	await prospectShow(args, ctx);
	return notes.join("\n");
}

describe("session summary report (issue #105)", () => {
	it("surfaces the existing summary node with its synthesis and evidence — no new analysis", async () => {
		const db = openAsyncDatabase(dbPath);
		let text = "";
		try {
			const result = await readSessionSummary(db, "s1");
			text = result.text;
			assert.equal(result.node.analyzer_id, "session-overview");
			assert.equal(result.node.node_kind, "summary");
		} finally {
			await db.close();
		}
		// The synthesis itself is readable…
		assert.match(text, /Session summary [0-9a-f]{12}  \(session-overview\)/);
		assert.match(text, /tried to fix a login bug/);
		assert.match(text, /Friction \(1\):/);
		assert.match(text, /\[high\] guessed the auth module path/);
		assert.match(text, /What went well \(1\):/);
		assert.match(text, /clean recovery after the correction/);
		assert.match(text, /Stats: pairs=\d+/);
		// …with its evidence walk-back: the verbatim turns behind it.
		assert.match(text, /Anchored turns — \d+ high-signal turn\(s\) of \d+ consumed/);
		assert.match(text, /no, that's wrong, use the auth module instead/); // verbatim user correction
		// …and what the summary yielded.
		assert.match(text, /Proposals from this summary \(1\)/);
		assert.match(text, /Document the auth module/);
	});

	it("is reachable as a session-level mode of prospect show", async () => {
		const text = await show("--session s1");
		assert.match(text, /Session summary/);
		assert.match(text, /Anchored turns/);
	});

	it("lists the proposals produced by the summary with resolvable ids", async () => {
		const db = openAsyncDatabase(dbPath);
		try {
			const proposalId = (await listProposals(db))[0]!.id;
			const text = (await readSessionSummary(db, "s1")).text;
			assert.ok(text.includes(proposalId.slice(0, 8)), `expected ${proposalId.slice(0, 8)} in:\n${text}`);
		} finally {
			await db.close();
		}
	});

	it("throws honestly when the session has no completed overview", async () => {
		const db = openAsyncDatabase(dbPath);
		try {
			await assert.rejects(() => readSessionSummary(db, "no-such-session"), /No session summary found for 'no-such-session'/);
		} finally {
			await db.close();
		}
	});

	it("warns on a missing --session value or unknown flag via the command surface", async () => {
		assert.match(await show("--session"), /Usage: prospect show/);
		assert.match(await show("--bogus"), /Unknown flag: --bogus/);
	});
});
