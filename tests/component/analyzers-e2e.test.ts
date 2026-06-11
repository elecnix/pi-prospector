import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { registerDefaults } from "../../src/analyze/defaults.js";
import { sessionOverviewAnalyzer } from "../../src/analyze/analyzers/session-overview/index.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { turnPairLLMAnalyzer } from "../../src/analyze/analyzers/turn-pair-llm/index.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { listProposals } from "../../src/db/queries.js";
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
	// reduce
	return JSON.stringify({
		session_summary: "The agent took a wrong approach and was corrected.",
		key_friction_points: [{ description: "wrong approach to auth", severity: "high" }],
		improvement_proposals: [
			{
				target_type: "agents_md",
				target_path: "AGENTS.md § Auth",
				title: "Document the auth module location",
				summary: "Tell the agent where auth code lives",
				detail: "Add a note pointing at src/auth.",
				evidence: "User corrected the agent in turn 2.",
				confidence: 0.7,
				severity: "correction",
			},
		],
	});
}

function seedSession(db: import("better-sqlite3").Database, id: string): void {
	insertSession(db, id);
	insertMessages(db, id, [
		{ role: "user", text: "fix the login bug" },
		{ role: "assistant", text: "reading auth", toolCalls: [{ name: "read" }] },
		{ role: "toolResult", toolResults: [{ toolName: "read", isError: true, textLength: 80 }] },
		{ role: "user", text: "no, that's wrong, use the auth module instead" },
		{ role: "assistant", text: "understood, fixing now" },
	]);
}

describe("analyzers end-to-end", () => {
	it("runs the full pipeline and materialises proposals", async () => {
		const { db, close } = tempDb();
		try {
			seedSession(db, "s1");
			const mock = createMockLLM({ responder: respond, tokensPerCall: 100, costPerCall: 0.001 });
			const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			registerDefaults(fw);

			const summary = await fw.run("s1", { mode: "shallow" });
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			const kinds = db.prepare("SELECT node_kind, COUNT(*) AS c FROM analysis_nodes GROUP BY node_kind").all() as Array<{ node_kind: string; c: number }>;
			const byKind = Object.fromEntries(kinds.map((k) => [k.node_kind, k.c]));
			assert.ok(byKind["metric"] >= 2, "expected turn-pair-core metric nodes");
			assert.ok(byKind["classification"] >= 1, "expected at least one llm classification node");
			assert.equal(byKind["summary"], 1, "expected one session-overview summary node");

			assert.ok(summary.proposalsCreated >= 1);
			const proposals = listProposals(db);
			assert.equal(proposals.length, 1);
			assert.equal(proposals[0]!.target_type, "agents_md");
			assert.ok(summary.costUsd > 0);

			// The LLM was only consulted for high-signal pairs + the overview.
			assert.ok(mock.calls.length >= 2);
		} finally {
			close();
		}
	});

	it("exercises the map-reduce path when the digest is large", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s2");
			// Many corrective turns so the digest exceeds the (tiny) threshold.
			const msgs = [];
			for (let i = 0; i < 6; i++) {
				msgs.push({ role: "user", text: `no, that's wrong, do approach number ${i} instead please` });
				msgs.push({ role: "assistant", text: `ok approach ${i}` });
			}
			insertMessages(db, "s2", msgs);

			const mock = createMockLLM({ responder: respond, tokensPerCall: 10, costPerCall: 0.0001 });
			const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });

			// session-overview variant with tiny map-reduce thresholds.
			const tinyOverview = {
				...sessionOverviewAnalyzer,
				defaultConfig: {
					...sessionOverviewAnalyzer.defaultConfig,
					configJson: {
						mapTier: "cheap",
						reduceTier: "mid",
						temperature: 0,
						mapReduceOverChars: 50,
						segmentChars: 80,
						maxSegments: 12,
					},
				},
			};
			fw.register(turnPairCoreAnalyzer);
			fw.register(turnPairLLMAnalyzer);
			fw.register(tinyOverview);

			const summary = await fw.run("s2", { mode: "shallow" });
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			// At least one map call must have happened (summarise one segment).
			const mapCalls = mock.calls.filter((c) => (c.system ?? "").includes("summarise one segment"));
			assert.ok(mapCalls.length >= 1, "expected map-phase calls");
		} finally {
			close();
		}
	});
});
