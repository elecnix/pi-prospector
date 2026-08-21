import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openAsyncDatabase, type AsyncDatabase } from "../../src/db/async-db.js";
import { migrate } from "../../src/db/schema.js";
import { insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { registerDefaults } from "../../src/analyze/defaults.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { insertNode } from "../../src/db/analysis-queries.js";
import { readNodes, readNodeDetail, prospectNodes } from "../../src/commands/nodes.js";
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
let db: AsyncDatabase;

/**
 * Two synthetic frustration-lexicon verdicts for the same term (a versioned
 * lineage — the newer revises nothing here, it is simply newer), plus one for a
 * second term. This is the corpus the generic `--latest-per-key term` option
 * exists for: newest verdict per term without a lexicon-specific command.
 */
async function insertLexiconNode(id: string, outputKey: string, createdAt: string, content: Record<string, unknown>): Promise<void> {
	await insertNode(db, {
		id,
		sessionId: "s1",
		analyzerId: "frustration-lexicon",
		analyzerVersionId: "frustration-lexicon-v1",
		configId: "cfg",
		runId: null,
		nodeKind: "classification",
		contentJson: JSON.stringify(content),
		sourceSetHash: `sset-${id}`,
		inputKey: `ik-${id}`,
		outputKey,
		createdAt,
	});
}

before(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prospector-nodes-"));
	dbPath = path.join(tmpDir, "nodes.db");
	process.env["PROSPECTOR_DB_PATH"] = dbPath;
	db = openAsyncDatabase(dbPath);
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

	await insertLexiconNode("lex-old", "ok-lex-old", "2026-01-01T00:00:00.000Z", {
		term: "putain", polarity: "frustration", category: "profanity", language: "fr", confidence: 0.8, rationale: "older verdict",
	});
	await insertLexiconNode("lex-new", "ok-lex-new", "2026-02-01T00:00:00.000Z", {
		term: "putain", polarity: "praise", category: "praise", language: "fr", confidence: 0.9, rationale: "newer verdict",
	});
	await insertLexiconNode("lex-other", "ok-lex-other", "2026-01-15T00:00:00.000Z", {
		term: "не то", polarity: "frustration", category: "negation", language: "ru", confidence: 0.85, rationale: "another term",
	});
});

after(async () => {
	delete process.env["PROSPECTOR_DB_PATH"];
	await db.close();
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("prospect nodes (surface read)", () => {
	it("lists an analyzer's nodes with kind, session and content digest", async () => {
		const { text, rows, total } = await readNodes(db, { analyzerId: "turn-pair-core", filters: [] });
		assert.equal(rows.length, 2, "two turns → two core metric nodes");
		assert.equal(total, 2);
		assert.match(text, /analyzer=turn-pair-core/);
		assert.match(text, /2 shown of 2 matching/);
		for (const row of rows) assert.equal(row.node_kind, "metric");
	});

	it("requires --analyzer or --all", async () => {
		await assert.rejects(() => readNodes(db, { filters: [] }), /Usage: prospect nodes/);
	});

	it("rejects --analyzer together with --all", async () => {
		await assert.rejects(() => readNodes(db, { analyzerId: "turn-pair-core", all: true, filters: [] }), /not both/);
	});

	it("rejects an unknown node kind", async () => {
		await assert.rejects(() => readNodes(db, { analyzerId: "turn-pair-core", nodeKind: "vibe", filters: [] }), /unknown --node-kind/);
	});

	it("--all reads every analyzer's nodes", async () => {
		const { rows } = await readNodes(db, { all: true, limit: 1000, filters: [] });
		const analyzers = new Set(rows.map((r) => r.analyzer_id));
		assert.ok(analyzers.has("turn-pair-core"), "core metrics present");
		assert.ok(analyzers.has("session-overview"), "session summary present");
		assert.ok(analyzers.has("frustration-lexicon"), "synthetic lexicon nodes present");
	});

	it("--node-kind restricts to one kind", async () => {
		const { rows } = await readNodes(db, { analyzerId: "turn-pair-llm", nodeKind: "classification", filters: [] });
		assert.ok(rows.length > 0);
		for (const row of rows) assert.equal(row.node_kind, "classification");
	});

	it("--filter is typed against the analyzer's declared outputSchema", async () => {
		// high_signal is Type.Boolean() in TurnPairCoreProperties: "true" coerces, "yes" throws.
		const { rows } = await readNodes(db, { analyzerId: "turn-pair-core", filters: ["high_signal=true"] });
		for (const row of rows) assert.equal(JSON.parse(row.content_json).high_signal, true);
		await assert.rejects(
			() => readNodes(db, { analyzerId: "turn-pair-core", filters: ["high_signal=yes"] }),
			/declared boolean, value must be true or false/,
		);
		// pair_index is a number.
		const one = await readNodes(db, { analyzerId: "turn-pair-core", filters: ["pair_index=1"] });
		assert.equal(one.rows.length, 1);
		assert.equal(JSON.parse(one.rows[0]!.content_json).pair_index, 1);
	});
	it("--filter falls back best-effort for an unregistered analyzer", async () => {
		const { text, rows } = await readNodes(db, { analyzerId: "no-such-analyzer", filters: [] });
		assert.match(text, /not registered locally/);
		assert.equal(rows.length, 0);
	});

	it("--counts groups counts over a property across all matching nodes", async () => {
		const { text } = await readNodes(db, { analyzerId: "frustration-lexicon", counts: "polarity", filters: [] });
		assert.match(text, /Counts by 'polarity'/);
		// The two synthetic non-neutral verdicts are counted alongside whatever the
		// pipeline's own lexicon run judged neutral on this fixture.
		assert.match(text, /frustration: 2/);
		assert.match(text, /praise: 1/);
	});

	it("--latest-per-key keeps only the newest verdict per term", async () => {
		const { rows } = await readNodes(db, { analyzerId: "frustration-lexicon", latestPerKey: "term", filters: [] });
		const byTerm = new Map(rows.map((r) => [JSON.parse(r.content_json).term as string, JSON.parse(r.content_json)]));
		const terms = rows.map((r) => (JSON.parse(r.content_json) as { term?: string }).term);
		assert.equal(new Set(terms).size, terms.length, "each term appears exactly once");
		const putain = byTerm.get("putain");
		assert.ok(putain);
		assert.equal(putain.polarity, "praise", "the newest verdict wins");
	});

	it("--latest-per-key reports nodes lacking the key instead of dropping them silently", async () => {
		const { text } = await readNodes(db, { analyzerId: "turn-pair-core", latestPerKey: "term", filters: [] });
		assert.match(text, /note: 2 node\(s\) lack 'term'/);
	});

	it("--limit/--offset page through the matches", async () => {
		const all = await readNodes(db, { analyzerId: "turn-pair-core", filters: [] });
		assert.equal(all.rows.length, 2);
		const page1 = await readNodes(db, { analyzerId: "turn-pair-core", limit: 1, filters: [] });
		assert.equal(page1.rows.length, 1);
		assert.match(page1.text, /--offset 1/);
		const page2 = await readNodes(db, { analyzerId: "turn-pair-core", limit: 1, offset: 1, filters: [] });
		assert.equal(page2.rows.length, 1);
		const seen = new Set([...page1.rows, ...page2.rows].map((r) => r.output_key));
		assert.equal(seen.size, 2, "pages do not overlap and cover everything");
	});

	it("the slash command prints the listing through ctx.ui.notify", async () => {
		notes.length = 0;
		await prospectNodes("--analyzer frustration-lexicon --counts category", ctx);
		assert.equal(notes.length, 1);
		assert.match(notes[0]!, /analyzer=frustration-lexicon/);
		assert.match(notes[0]!, /Counts by 'category'/);
	});

	it("the slash command reports usage errors as warnings", async () => {
		notes.length = 0;
		await prospectNodes("--bogus", ctx);
		assert.match(notes[0]!, /unknown flag or stray argument/);
	});
});

describe("prospect node (edge navigation)", () => {
	it("shows a node's detail with resolved outgoing edges", async () => {
		const overview = await readNodes(db, { analyzerId: "session-overview", filters: [] });
		assert.equal(overview.rows.length, 1);
		const { text } = await readNodeDetail(db, overview.rows[0]!.output_key);
		assert.match(text, new RegExp(`Node ${overview.rows[0]!.output_key}`));
		assert.match(text, /kind:\s+summary/);
		assert.match(text, /Outgoing edges \(\d+\):/);
		assert.match(text, /consumes\s+→ node/, "consumes edges resolve to their target nodes");
		assert.match(text, /anchors\s+→ session s1/, "session anchors resolve");
	});

	it("resolves anchors of a turn node to the verbatim message", async () => {
		const core = await readNodes(db, { analyzerId: "turn-pair-core", filters: ["pair_index=0"] });
		assert.equal(core.rows.length, 1);
		const { text } = await readNodeDetail(db, core.rows[0]!.output_key);
		assert.match(text, /anchors\s+→ message .* \[user\] fix the login bug/);
	});

	it("resolves an output-key prefix when given unambiguously", async () => {
		const { text } = await readNodeDetail(db, "ok-lex-new");
		assert.match(text, /Node ok-lex-new/);
		const prefixed = await readNodeDetail(db, "ok-lex-ne");
		assert.match(prefixed.text, /Node ok-lex-new/);
	});

	it("reports ambiguous prefixes with the candidates", async () => {
		await assert.rejects(() => readNodeDetail(db, "ok-lex"), /matches 3 nodes.*copy a longer prefix/s);
	});

	it("reports an unknown reference honestly", async () => {
		await assert.rejects(() => readNodeDetail(db, "no-such-key"), /No node matches/);
	});
});
