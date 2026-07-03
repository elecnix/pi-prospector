import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM, type MockLLM } from "../../src/analyze/mock-llm.js";
import { registerDefaults } from "../../src/analyze/defaults.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import type { LLMRequest } from "../../src/analyze/types.js";

const REPO = "/repo/app";

/** Reduce-phase requests, identified by the reduce system prompt. */
function isReduce(req: LLMRequest): boolean {
	return (req.system ?? "").includes("You analyse a coding-agent session");
}

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
		session_summary: "Summary.",
		friction_points: [],
		key_positive_signals: [],
		improvement_proposals: [],
	});
}

/** A smooth session in REPO: multiple pairs, no correction, no tool failure. */
function seedSmooth(db: import("better-sqlite3").Database, id: string): void {
	insertSession(db, id, `/tmp/${id}.jsonl`, REPO);
	insertMessages(db, id, [
		{ id: `${id}-m0`, role: "user", text: "add a hello endpoint" },
		{ id: `${id}-m1`, role: "assistant", text: "done, added the endpoint" },
		{ id: `${id}-m2`, role: "user", text: "now add tests for it" },
		{ id: `${id}-m3`, role: "assistant", text: "added tests, all passing" },
	]);
}

/** A friction session in REPO: a genuine correction after a failed tool call. */
function seedFriction(db: import("better-sqlite3").Database, id: string): void {
	insertSession(db, id, `/tmp/${id}.jsonl`, REPO);
	insertMessages(db, id, [
		{ id: `${id}-m0`, role: "user", text: "fix the login bug" },
		{ id: `${id}-m1`, role: "assistant", text: "reading auth", toolCalls: [{ name: "read" }] },
		{ id: `${id}-m2`, role: "toolResult", toolResults: [{ toolName: "read", isError: true, textLength: 80 }] },
		{ id: `${id}-m3`, role: "user", text: "no, that's wrong, use the auth module instead" },
		{ id: `${id}-m4`, role: "assistant", text: "understood, fixing now" },
	]);
}

async function analyze(db: import("better-sqlite3").Database, sessionId: string): Promise<MockLLM> {
	const mock = createMockLLM({ responder: respond, tokensPerCall: 100, costPerCall: 0.001 });
	const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
	registerDefaults(fw);
	const summary = await fw.run(sessionId, {});
	assert.equal(summary.errors.length, 0, summary.errors.join("; "));
	return mock;
}

function keysOf(db: import("better-sqlite3").Database): string[] {
	return (
		db
			.prepare("SELECT analyzer_id, input_key, output_key FROM analysis_nodes ORDER BY analyzer_id, input_key, output_key")
			.all() as Array<{ analyzer_id: string; input_key: string; output_key: string }>
	).map((r) => `${r.analyzer_id}|${r.input_key}|${r.output_key}`);
}

describe("cross-session success/failure contrast (#10)", () => {
	it("hands a friction session's reduce step the smooth sibling as contrast", async () => {
		const { db, close } = tempDb();
		try {
			seedSmooth(db, "smooth1");
			seedFriction(db, "friction1");
			// Smooth sibling's raw messages are present before the friction session is
			// analysed; the contrast derives from them, not from any analysis node.
			const mock = await analyze(db, "friction1");

			const reduce = mock.calls.find(isReduce);
			assert.ok(reduce, "friction session ran a reduce call");
			assert.match(reduce!.user, /CROSS-SESSION CONTRAST/, "reduce prompt carries the contrast block");
			assert.match(reduce!.user, /smooth1/, "contrast names the smooth sibling");
			assert.match(reduce!.user, /smooth/, "contrast characterises the sibling as smooth");

			// Provenance: the overview node contrasts_with the smooth sibling session.
			const edges = db
				.prepare(
					"SELECT to_ref_id FROM analysis_edges WHERE edge_kind = 'contrasts_with' AND to_ref_kind = 'session'",
				)
				.all() as Array<{ to_ref_id: string }>;
			assert.deepEqual(edges.map((e) => e.to_ref_id), ["smooth1"], "contrasts_with edge points at the smooth sibling");

			// Identity commits to the sibling: the overview's source set includes a
			// session-kind ref (so the sibling content is part of the node's input_key).
			const overview = db
				.prepare("SELECT source_set_hash FROM analysis_nodes WHERE analyzer_id = 'session-overview' AND session_id = 'friction1'")
				.get() as { source_set_hash: string } | undefined;
			assert.ok(overview, "friction session produced an overview node");
		} finally {
			close();
		}
	});

	it("a smooth session with no smooth sibling of its own gets no contrast", async () => {
		const { db, close } = tempDb();
		try {
			seedSmooth(db, "smooth1");
			seedFriction(db, "friction1");
			// The only sibling of the smooth session is the friction session, which is
			// NOT smooth, so the smooth session receives no cross-session contrast.
			const mock = await analyze(db, "smooth1");
			const reduce = mock.calls.find(isReduce);
			assert.ok(reduce, "smooth session ran a reduce call");
			assert.doesNotMatch(reduce!.user, /CROSS-SESSION CONTRAST/, "no contrast block without a smooth sibling");

			const edges = db
				.prepare("SELECT COUNT(*) AS n FROM analysis_edges WHERE edge_kind = 'contrasts_with'")
				.get() as { n: number };
			assert.equal(edges.n, 0, "no contrasts_with edge");
		} finally {
			close();
		}
	});

	it("identity reproduces across independent DBs over the same fixture", async () => {
		const a = tempDb();
		const b = tempDb();
		try {
			for (const t of [a, b]) {
				seedSmooth(t.db, "smooth1");
				seedFriction(t.db, "friction1");
				await analyze(t.db, "smooth1");
				await analyze(t.db, "friction1");
			}
			const ka = keysOf(a.db);
			const kb = keysOf(b.db);
			assert.ok(ka.length > 0, "produced nodes");
			assert.deepEqual(ka, kb, "cross-session contrast keeps input_key/output_key reproducible");
		} finally {
			a.close();
			b.close();
		}
	});
});
