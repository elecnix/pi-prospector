import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/schema.js";
import { insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { registerDefaults } from "../../src/analyze/defaults.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { listProposals } from "../../src/db/queries.js";
import { resolveProposal, prospectShow } from "../../src/commands/show.js";
import type { LLMRequest } from "../../src/analyze/types.js";
import type { ExtensionCommandContext } from "../../src/pi-stubs.js";

function respond(req: LLMRequest): string {
	const sys = req.system ?? "";
	if (sys.includes("classify a single turn")) {
		return JSON.stringify({ sentiment: "frustrated", friction_type: "wrong_approach", is_genuine_correction: true, severity: "high", rationale: "corrected" });
	}
	if (sys.includes("summarise one segment")) return JSON.stringify({ segment_summary: "seg", notable_points: [] });
	return JSON.stringify({
		session_summary: "A wrong approach was corrected.",
		friction_points: [{ description: "wrong approach", what_to_change: "document the correct approach", evidence: "user corrected in turn 2", severity: "high" }],
		key_positive_signals: [],
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
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prospector-show-"));
	dbPath = path.join(tmpDir, "show.db");
	process.env["PROSPECTOR_DB_PATH"] = dbPath;
	const db = new Database(dbPath);
	migrate(db);
	insertSession(db, "s1");
	insertMessages(db, "s1", [
		{ id: "s1-m0", role: "user", text: "fix the login bug" },
		{ id: "s1-m1", role: "assistant", text: "reading auth", toolCalls: [{ name: "read" }] },
		{ id: "s1-m2", role: "toolResult", toolResults: [{ toolName: "read", isError: true, textLength: 40 }] },
		{ id: "s1-m3", role: "user", text: "no, that's wrong, use the auth module instead" },
		{ id: "s1-m4", role: "assistant", text: "understood" },
	]);
	const mock = createMockLLM({ responder: respond, tokensPerCall: 50, costPerCall: 0.001 });
	const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
	registerDefaults(fw);
	const summary = await fw.run("s1", {});
	assert.equal(summary.errors.length, 0, summary.errors.join("; "));
	db.close();
});

after(() => {
	delete process.env["PROSPECTOR_DB_PATH"];
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

async function show(ref: string): Promise<string> {
	notes.length = 0;
	await prospectShow(ref, ctx);
	return notes.join("\n");
}

describe("prospect-show", () => {
	it("resolves a proposal by exact id and by unambiguous prefix; rejects unknown", () => {
		const db = new Database(dbPath);
		try {
			const all = listProposals(db);
			assert.ok(all.length >= 1);
			const id = all[0]!.id;
			assert.equal(resolveProposal(db, id).proposal?.id, id);
			assert.equal(resolveProposal(db, id.slice(0, 18)).proposal?.id, id);
			assert.equal(resolveProposal(db, "no-such-id").matches.length, 0);
		} finally {
			db.close();
		}
	});

	it("prints the proposal and reconstructs the verbatim anchored turns from the graph", async () => {
		const db = new Database(dbPath);
		const id = listProposals(db)[0]!.id;
		db.close();

		const text = await show(id);
		assert.match(text, /Document the auth module/); // proposal title
		assert.match(text, /Anchored turns/);
		assert.match(text, /no, that's wrong, use the auth module/); // verbatim user correction
		assert.match(text, /session-overview/); // source provenance shown
	});

	it("warns on an unknown proposal id", async () => {
		const text = await show("definitely-not-a-real-id");
		assert.match(text, /No proposal matches/);
	});
});
