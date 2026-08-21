/**
 * Component test for routing-opportunity (analyzer) + model-mix (read-time
 * frontier fold). Seeds a small cross-session corpus — cheap, clean, easy turns
 * on `m-cheap` and expensive, easy turns on `m-pricey` — and asserts:
 *   - routing-opportunity labels each turn (with model + cost + verdict)
 *   - the routing corpus is additive and concurrency-stable (no cross-session
 *     cumulative node is produced — the frontier is a read-time fold)
 *   - aggregateModels over the routing corpus returns a single dominated-model
 *     recommendation, and only above the min-turn threshold
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages, type TempDb } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { registerAll } from "../../src/analyze/defaults.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { toolTrajectoryAnalyzer } from "../../src/analyze/analyzers/tool-trajectory/index.js";
import { routingOpportunityAnalyzer } from "../../src/analyze/analyzers/routing-opportunity/index.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { aggregateModels } from "../../src/analyze/analyzers/model-mix/index.js";
import { DEFAULT_MODEL_MIX_CONFIG } from "../../src/analyze/analyzers/model-mix/config.js";
import type { AnalysisNodeRow } from "../../src/analyze/types.js";

function easyTurn(model: string, costUsd: number, n: number, sid: string) {
	return [
		{ id: `${sid}-${n}-u`, role: "user" as const, text: "do a thing" },
		{ id: `${sid}-${n}-a`, role: "assistant" as const, text: "ok", model, costUsd, toolCalls: [{ name: "edit", arguments: { path: "/x.ts" } }] },
		{ id: `${sid}-${n}-r`, role: "toolResult" as const, toolResults: [{ toolName: "edit", isError: false, textLength: 100 }] },
	];
}

function queryRoutingNodes(db: import("better-sqlite3").Database): AnalysisNodeRow[] {
	return db
		.prepare("SELECT id, session_id, analyzer_id, analyzer_version_id, config_id, run_id, node_kind, content_json, source_set_hash, input_key, output_key, config_fingerprint, model_used, cost_usd, tokens_used, duration_ms, created_at FROM analysis_nodes WHERE analyzer_id = 'routing-opportunity'")
		.all() as AnalysisNodeRow[];
}

describe("routing-opportunity + model-mix frontier", () => {
	it("labels every turn and folds a single dominated-model recommendation at read time", async () => {
		const t: TempDb = await tempDb();
		try {
			const s1 = "mix1";
			const s2 = "mix2";
			await insertSession(t.db, s1);
			await insertSession(t.db, s2);

			const m1: Array<ReturnType<typeof easyTurn>[number]> = [];
			for (let i = 0; i < 25; i++) m1.push(...easyTurn("m-cheap", 0.001, i, s1));
			await insertMessages(t.db, s1, m1);

			const m2: Array<ReturnType<typeof easyTurn>[number]> = [];
			for (let i = 0; i < 25; i++) m2.push(...easyTurn("m-pricey", 0.05, i, s2));
			await insertMessages(t.db, s2, m2);

			const mock = createMockLLM({ responder: () => "{}", tokensPerCall: 0, costPerCall: 0 });
			const fw = new AnalyzerFramework({ db: t.db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			const { errors } = await registerAll(fw, { builtins: [turnPairCoreAnalyzer, toolTrajectoryAnalyzer, routingOpportunityAnalyzer] });
			assert.deepEqual(errors, [], JSON.stringify(errors));

			const r1 = await fw.run(s1, { analyzerIds: ["routing-opportunity"] });
			assert.equal(r1.errors.length, 0, r1.errors.join("; "));
			const r2 = await fw.run(s2, { analyzerIds: ["routing-opportunity"] });
			assert.equal(r2.errors.length, 0, r2.errors.join("; "));

			// ── routing labels every turn ──
			const routingNodes = queryRoutingNodes(t.db);
			assert.equal(routingNodes.length, 50, "one routing node per turn across the corpus");
			const first = JSON.parse(routingNodes[0]!.content_json);
			assert.equal(first.verdict, "downshift", "easy turn labelled downshift");
			assert.equal(first.model, "m-cheap");
			assert.equal(first.turn_cost_usd, 0.001);

			// ── read-time frontier fold ──
			const { result, suggestions } = aggregateModels(routingNodes, DEFAULT_MODEL_MIX_CONFIG);
			assert.equal(result.corpus.routing_turn_count, 50);
			assert.equal(result.corpus.session_count, 2);
			assert.equal(result.corpus.unrecorded_model_turn_count, 0);

			const cheap = result.per_model.find((s) => s.model === "m-cheap")!;
			const pricey = result.per_model.find((s) => s.model === "m-pricey")!;
			assert.ok(cheap && cheap.turn_count === 25);
			assert.ok(pricey && pricey.turn_count === 25);
			assert.ok(cheap.avg_cost_per_priced_turn! < pricey.avg_cost_per_priced_turn!);

			const dominated = suggestions.find((s) => s.title.includes("dominated"));
			assert.ok(dominated, "pricey, no-better model flagged as dominated");
			assert.ok(dominated!.title.includes("m-pricey"));
		} finally {
			t.close();
		}
	});

	it("yields no recommendation below the min-turn threshold (thin corpus)", async () => {
		const t: TempDb = await tempDb();
		try {
			const s1 = "thin1";
			await insertSession(t.db, s1);
			const m1: Array<ReturnType<typeof easyTurn>[number]> = [];
			for (let i = 0; i < 2; i++) m1.push(...easyTurn("m-cheap", 0.001, i, s1));
			await insertMessages(t.db, s1, m1);

			const mock = createMockLLM({ responder: () => "{}", tokensPerCall: 0, costPerCall: 0 });
			const fw = new AnalyzerFramework({ db: t.db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			await registerAll(fw, { builtins: [turnPairCoreAnalyzer, toolTrajectoryAnalyzer, routingOpportunityAnalyzer] });
			await fw.run(s1, { analyzerIds: ["routing-opportunity"] });

			const nodes = queryRoutingNodes(t.db);
			assert.equal(nodes.length, 2);
			const { suggestions } = aggregateModels(nodes, DEFAULT_MODEL_MIX_CONFIG);
			assert.equal(suggestions.length, 0, "two-turn sample must not produce a verdict");
		} finally {
			t.close();
		}
	});
});
