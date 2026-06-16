import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { registerDefaults } from "../../src/analyze/defaults.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { mapWithConcurrency } from "../../src/analyze/concurrency.js";
import { listProposals } from "../../src/db/queries.js";
import type { LLMRequest } from "../../src/analyze/types.js";

/** Deterministic mock: every LLM step returns fixed structured output. */
function respond(req: LLMRequest): import("../../src/analyze/mock-llm.js").MockLLMReply {
	if (req.tool?.name === "classify_turn") {
		return {
			text: "x",
			structured: {
				sentiment: "frustrated",
				friction_type: "wrong_approach",
				is_genuine_correction: true,
				severity: "high",
				rationale: "corrected",
			},
		};
	}
	if (req.tool?.name === "submit_segment_summary") {
		return { text: "x", structured: { segment_summary: "seg", notable_points: ["p"] } };
	}
	// reduce
	return {
		text: "x",
		structured: {
			session_summary: "A session with a correction.",
			friction_points: [
				{ description: "wrong approach", what_to_change: "document the module", evidence: "turn 2", severity: "high" },
			],
			key_positive_signals: [],
			improvement_proposals: [
				{
					target_type: "agents_md",
					target_path: "AGENTS.md",
					title: "Document the module",
					summary: "Tell the agent where it lives",
					detail: "Add a note.",
					evidence: "User corrected in turn 2.",
					confidence: 0.7,
					severity: "correction",
				},
			],
		},
	};
}

function seed(db: import("better-sqlite3").Database, id: string): void {
	insertSession(db, id);
	insertMessages(db, id, [
		{ role: "user", text: "fix the login bug" },
		{ role: "assistant", text: "reading auth", toolCalls: [{ name: "read" }] },
		{ role: "toolResult", toolResults: [{ toolName: "read", isError: true, textLength: 80 }] },
		{ role: "user", text: "no, that's wrong, use the auth module instead" },
		{ role: "assistant", text: "understood, fixing now" },
	]);
}

const SESSIONS = ["s1", "s2", "s3", "s4", "s5"];

/** Copy sessions + messages verbatim so two DBs have byte-identical inputs. */
function copyInputs(from: import("better-sqlite3").Database, to: import("better-sqlite3").Database): void {
	const cols = (rows: Record<string, unknown>[], table: string): void => {
		for (const r of rows) {
			const keys = Object.keys(r);
			to.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(
				...keys.map((k) => r[k] as never),
			);
		}
	};
	cols(from.prepare("SELECT * FROM sessions").all() as Record<string, unknown>[], "sessions");
	cols(from.prepare("SELECT * FROM messages").all() as Record<string, unknown>[], "messages");
}

/** Sorted (input_key, output_key) of every node, plus sorted proposal input_keys. */
function fingerprint(db: import("better-sqlite3").Database): { nodes: string[]; proposals: string[] } {
	const nodes = (db.prepare("SELECT input_key, output_key FROM analysis_nodes").all() as Array<{ input_key: string; output_key: string }>)
		.map((n) => `${n.input_key}:${n.output_key}`)
		.sort();
	const proposals = listProposals(db)
		.map((p) => p.input_key)
		.sort();
	return { nodes, proposals };
}

describe("concurrency does not change analysis identity", () => {
	it("a concurrent session run yields the same nodes + proposals as a sequential one", async () => {
		// Baseline: process every session sequentially.
		const seq = tempDb();
		// Concurrent: same fixtures, processed with a worker pool over one shared
		// connection (exactly how the analyze command drives a corpus run).
		const conc = tempDb();
		try {
			for (const id of SESSIONS) seed(seq.db, id);
			// Byte-identical inputs: copy the seeded rows rather than re-seeding (the
			// shared insert helpers use a global id/timestamp counter, so re-seeding
			// would itself diverge the inputs and mask what we are testing).
			copyInputs(seq.db, conc.db);

			const seqFw = new AnalyzerFramework({ db: seq.db, llm: createMockLLM({ responder: respond }).caller, modelTiers: DEFAULT_MODEL_TIERS });
			registerDefaults(seqFw);
			for (const id of SESSIONS) await seqFw.run(id, {});

			const concFw = new AnalyzerFramework({ db: conc.db, llm: createMockLLM({ responder: respond }).caller, modelTiers: DEFAULT_MODEL_TIERS });
			registerDefaults(concFw);
			await mapWithConcurrency(SESSIONS, 4, (id) => concFw.run(id, {}));

			const a = fingerprint(seq.db);
			const b = fingerprint(conc.db);
			assert.deepEqual(b.nodes, a.nodes, "node identities must be independent of concurrency");
			assert.deepEqual(b.proposals, a.proposals, "proposal identities must be independent of concurrency");
			assert.ok(a.nodes.length > 0 && a.proposals.length > 0, "the run actually produced work");
		} finally {
			seq.close();
			conc.close();
		}
	});

	it("a concurrent run is idempotent: a second concurrent pass produces nothing new", async () => {
		const { db, close } = tempDb();
		try {
			for (const id of SESSIONS) seed(db, id);
			const fw = new AnalyzerFramework({ db, llm: createMockLLM({ responder: respond }).caller, modelTiers: DEFAULT_MODEL_TIERS });
			registerDefaults(fw);

			const first = await mapWithConcurrency(SESSIONS, 4, (id) => fw.run(id, {}));
			const producedFirst = first.reduce((s, r) => s + r.nodesProduced, 0);
			assert.ok(producedFirst > 0);

			const second = await mapWithConcurrency(SESSIONS, 4, (id) => fw.run(id, {}));
			const producedSecond = second.reduce((s, r) => s + r.nodesProduced, 0);
			assert.equal(producedSecond, 0, "a converged corpus produces no new nodes under concurrency");
		} finally {
			close();
		}
	});
});
