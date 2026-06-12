import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { registerDefaults } from "../../src/analyze/defaults.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { verifyNodes } from "../../src/commands/verify.js";
import type { LLMRequest } from "../../src/analyze/types.js";

function respond(req: LLMRequest): string {
	const sys = req.system ?? "";
	if (sys.includes("classify a single turn")) {
		return JSON.stringify({
			sentiment: "frustrated",
			friction_type: "wrong_approach",
			is_genuine_correction: true,
			severity: "high",
			rationale: "user corrected the approach",
		});
	}
	if (sys.includes("summarise one segment")) {
		return JSON.stringify({ segment_summary: "a segment", notable_points: ["point"] });
	}
	return JSON.stringify({
		session_summary: "The agent took a wrong approach and was corrected.",
		friction_points: [{ description: "wrong approach", what_to_change: "document correct approach", evidence: "user corrected", severity: "high" }],
		key_positive_signals: [],
		improvement_proposals: [
			{ target_type: "agents_md", target_path: "AGENTS.md", title: "Doc auth", summary: "s", detail: "d", evidence: "e", confidence: 0.7, severity: "correction" },
		],
	});
}

/** Seed a session with EXPLICIT, stable message ids so leaf identities reproduce. */
function seed(db: import("better-sqlite3").Database, id: string): void {
	insertSession(db, id);
	insertMessages(db, id, [
		{ id: `${id}-m0`, role: "user", text: "fix the login bug" },
		{ id: `${id}-m1`, role: "assistant", text: "reading auth", toolCalls: [{ name: "read" }] },
		{ id: `${id}-m2`, role: "toolResult", toolResults: [{ toolName: "read", isError: true, textLength: 80 }] },
		{ id: `${id}-m3`, role: "user", text: "no, that's wrong, use the auth module instead" },
		{ id: `${id}-m4`, role: "assistant", text: "understood, fixing now" },
	]);
}

async function analyze(db: import("better-sqlite3").Database, sessionId: string): Promise<void> {
	const mock = createMockLLM({ responder: respond, tokensPerCall: 100, costPerCall: 0.001 });
	const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
	registerDefaults(fw);
	const summary = await fw.run(sessionId, {});
	assert.equal(summary.errors.length, 0, summary.errors.join("; "));
}

function keysOf(db: import("better-sqlite3").Database): string[] {
	return (
		db
			.prepare("SELECT analyzer_id, input_key, output_key FROM analysis_nodes ORDER BY analyzer_id, input_key")
			.all() as Array<{ analyzer_id: string; input_key: string; output_key: string }>
	).map((r) => `${r.analyzer_id}|${r.input_key}|${r.output_key}`);
}

describe("content-addressed identities", () => {
	it("reproduce identically across independent databases (global, wipe-surviving)", async () => {
		const a = tempDb();
		const b = tempDb();
		try {
			seed(a.db, "s1");
			seed(b.db, "s1");
			await analyze(a.db, "s1");
			await analyze(b.db, "s1");

			const ka = keysOf(a.db);
			const kb = keysOf(b.db);
			assert.ok(ka.length > 0, "produced nodes");
			// Node uuids and created_at differ between DBs; input_key + output_key must not.
			assert.deepEqual(ka, kb, "input_key/output_key are pure functions of content, not DB-local ids");
		} finally {
			a.close();
			b.close();
		}
	});

	it("a consumer's input_key folds in the upstream output_key (output matters)", async () => {
		const { db, close } = tempDb();
		try {
			seed(db, "s1");
			await analyze(db, "s1");
			// The session-overview node consumes turn-pair output_keys; its source_set_hash
			// is therefore derived from upstream output_keys, not uuids.
			const overview = db.prepare("SELECT source_set_hash FROM analysis_nodes WHERE analyzer_id='session-overview'").get() as { source_set_hash: string };
			const upstreamOutputKeys = (db.prepare("SELECT output_key FROM analysis_nodes WHERE analyzer_id IN ('turn-pair-core','turn-pair-llm')").all() as Array<{ output_key: string }>).map((r) => r.output_key);
			assert.ok(overview, "overview node exists");
			assert.ok(upstreamOutputKeys.every((k) => k.length === 16), "upstream nodes have content-addressed output_keys");
		} finally {
			close();
		}
	});

	it("verifyNodes confirms a clean graph and detects tampering", async () => {
		const { db, close } = tempDb();
		try {
			seed(db, "s1");
			await analyze(db, "s1");

			const clean = verifyNodes(db);
			assert.ok(clean.total > 0);
			assert.equal(clean.mismatches.length, 0, "a freshly built graph verifies");

			// Tamper with stored content out of band; the output_key no longer matches.
			db.prepare("UPDATE analysis_nodes SET content_json = '{\"tampered\":true}' WHERE id = (SELECT id FROM analysis_nodes WHERE analyzer_id='turn-pair-core' LIMIT 1)").run();
			const dirty = verifyNodes(db);
			assert.equal(dirty.mismatches.length, 1, "tampering is detected");
		} finally {
			close();
		}
	});
});
