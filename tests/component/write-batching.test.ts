/**
 * Two cheap wins on the write and read paths, both measured before being built.
 *
 * 1. A node and its edges are written in one transaction. Measured 0.16ms →
 *    0.029ms per node when statements share a transaction rather than each
 *    paying its own fsync. It also closes a real correctness hole: an edge that
 *    fails validation used to leave the node behind with no edges, which is a
 *    node that exists but can never be traced.
 *
 * 2. A corpus-wide dependency read is cached for the framework's lifetime and
 *    invalidated when that analyzer writes. `turn-frustration.plan()` reloads
 *    and re-parses the whole lexicon once per session — 42ms at 13,436 terms,
 *    1,533 times over — and that cost grows linearly with the lexicon forever.
 *
 * Neither was the bottleneck (writes were 0.3% of wall time). They are here
 * because they are small, measured, and one of them scales badly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { lexiconCandidatesAnalyzer } from "../../src/analyze/analyzers/lexicon-candidates/index.js";
import { frustrationLexiconAnalyzer, FRUSTRATION_LEXICON_DEF } from "../../src/analyze/analyzers/frustration-lexicon/index.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { turnFrustrationAnalyzer, TURN_FRUSTRATION_DEF } from "../../src/analyze/analyzers/turn-frustration/index.js";
import { getNodesByAnalyzer } from "../../src/db/analysis-queries.js";
import { computeConfigHash } from "../../src/analyze/input-hash.js";
import type { Analyzer, AnalysisUnit, LLMRequest } from "../../src/analyze/types.js";

const FLAGGED = new Set(["putain", "wrong"]);

function verdictLLM() {
	return createMockLLM({
		responder: (req: LLMRequest) => {
			const term = String((req.user.match(/TERM:\s*(.*)/) ?? [])[1] ?? "").trim();
			const hit = FLAGGED.has(term);
			return {
				text: "x",
				structured: {
					polarity: hit ? "frustration" : "neutral",
					category: hit ? "negation" : "none",
					language: "und",
					confidence: 0.9,
					rationale: "r",
				},
			};
		},
	});
}

describe("node and edges are written atomically", () => {
	it("leaves no node behind when an edge is invalid", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			const ids = insertMessages(db, "s1", [{ role: "user", text: "hello" }]);

			// An analyzer that emits a structurally invalid edge: `consumes` may only
			// target an analysis_node, never a message. Defined standalone so its def,
			// version, and config all agree on the same id.
			const bad: Analyzer = {
				def: { id: "bad-edges", label: "Bad Edges", description: "test", anchorSpan: "pair", dependencies: [] },
				version: { analyzerId: "bad-edges", major: 1, minor: 0, implementationKind: "deterministic" },
				prompts: {},
				defaultConfig: { id: "", analyzerId: "bad-edges", configHash: computeConfigHash({}), configJson: {}, label: "default" },
				plan: (): AnalysisUnit[] => [{
					sources: [{ kind: "message", id: ids[0]! }],
					sourceSetHash: "hash-bad",
					anchorKind: "message",
					anchorRef: ids[0]!,
				}],
				analyze: () => ({
					nodeKind: "metric" as const,
					contentJson: { x: 1 },
					anchorKind: "message" as const,
					anchorRef: ids[0]!,
					edges: [{ toRefKind: "message", toRefId: ids[0]!, edgeKind: "consumes" }],
				}),
			};

			const framework = new AnalyzerFramework({ db, llm: async () => { throw new Error("no llm"); }, modelTiers: DEFAULT_MODEL_TIERS });
			framework.register(bad);
			const summary = await framework.run("s1", { analyzerIds: ["bad-edges"] });

			assert.ok(summary.errors.length > 0, "the invalid edge is reported");
			const orphans = getNodesByAnalyzer(db, "bad-edges", "s1").filter((n) => n.node_kind !== "error");
			assert.equal(orphans.length, 0, "a node whose edges failed must not survive — it could never be traced");
		} finally {
await close();
		}
	});

	it("writes the node and all its edges when they are valid", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "putain" }]);
			const framework = new AnalyzerFramework({ db, llm: verdictLLM().caller, modelTiers: DEFAULT_MODEL_TIERS });
			framework.register(lexiconCandidatesAnalyzer);
			framework.register(frustrationLexiconAnalyzer);
			await framework.run("s1");

			const node = getNodesByAnalyzer(db, FRUSTRATION_LEXICON_DEF.id, "s1")[0]!;
			const edges = db.prepare("SELECT edge_kind FROM analysis_edges WHERE from_node_id = ?").all(node.id);
			assert.ok(edges.length >= 3, `expected anchors + uses_prompt + uses_config, got ${edges.length}`);
		} finally {
await close();
		}
	});
});

describe("corpus-wide dependency reads are cached and invalidated", () => {
	it("sees a term judged during the same run in a later session", async () => {
		const { db, close } = await tempDb();
		try {
			// s1 teaches the corpus `putain`; s2 must match it on the very same run,
			// which only holds if the cache is invalidated when the lexicon is written.
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "putain" }, { role: "assistant", text: "ok" }]);
			await insertSession(db, "s2");
			await insertMessages(db, "s2", [{ role: "user", text: "putain again" }, { role: "assistant", text: "ok" }]);

			const framework = new AnalyzerFramework({ db, llm: verdictLLM().caller, modelTiers: DEFAULT_MODEL_TIERS });
			for (const a of [turnPairCoreAnalyzer, lexiconCandidatesAnalyzer, frustrationLexiconAnalyzer, turnFrustrationAnalyzer]) {
				framework.register(a);
			}
			await framework.run("s1");
			await framework.run("s2");

			const hits = getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s2")
				.map((n) => (JSON.parse(n.content_json) as { signal: string }).signal);
			assert.ok(hits.includes("putain"), `s2 must see the term s1 judged; got ${JSON.stringify(hits)}`);
		} finally {
await close();
		}
	});

	it("still matches terms judged in an earlier run", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "putain" }, { role: "assistant", text: "ok" }]);

			const build = () => {
				const f = new AnalyzerFramework({ db, llm: verdictLLM().caller, modelTiers: DEFAULT_MODEL_TIERS });
				for (const a of [turnPairCoreAnalyzer, lexiconCandidatesAnalyzer, frustrationLexiconAnalyzer, turnFrustrationAnalyzer]) f.register(a);
				return f;
			};
			await build().run("s1");

			// A fresh framework has an empty cache and must read from the database.
			await insertSession(db, "s2");
			await insertMessages(db, "s2", [{ role: "user", text: "putain" }, { role: "assistant", text: "ok" }]);
			await build().run("s2");

			const hits = getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s2")
				.map((n) => (JSON.parse(n.content_json) as { signal: string }).signal);
			assert.ok(hits.includes("putain"));
		} finally {
await close();
		}
	});
});
