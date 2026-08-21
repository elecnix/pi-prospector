/**
 * Component test for the `cache-economy` built-in analyzer.
 * Seeds a session with a cold start, a TTL-expiry miss, a prefix-instability
 * miss, and healthy hits, then asserts the analyzer's classifications,
 * aggregate hit ratio, write-churn counting, and proposal output.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AsyncDatabase } from "../../../src/db/async-db.js";
import { tempDb, insertSession, insertMessages, type TempDb } from "../helpers.js";
import { AnalyzerFramework } from "../../../src/analyze/framework.js";
import { createMockLLM } from "../../../src/analyze/mock-llm.js";
import { registerAll } from "../../../src/analyze/defaults.js";
import { DEFAULT_MODEL_TIERS } from "../../../src/analyze/model-tiers.js";
import { cacheEconomyAnalyzer } from "../../../src/analyze/analyzers/cache-economy/index.js";

async function setUsage(db: AsyncDatabase, id: string, u: Record<string, number>): Promise<void> {
	await db.prepare("UPDATE messages SET usage = ? WHERE id = ?").run(JSON.stringify(u), id);
}
async function setTimestamps(db: AsyncDatabase, sessionId: string, stamps: Record<string, number>): Promise<void> {
	const stmt = await db.prepare("UPDATE messages SET timestamp = ? WHERE id = ?");
	for (const [id, t] of Object.entries(stamps)) await stmt.run(new Date(t * 1000).toISOString(), id);
}

describe("cache-economy analyzer", () => {
	it("classifies cold hits by gap, computes hit ratio, counts churn, and emits proposals", async () => {
		const t: TempDb = await tempDb();
		try {
			const sid = "ce1";
			await insertSession(t.db, sid);
			await insertMessages(t.db, sid, [
				{ id: "u0", role: "user", text: "start" },
				{ id: "a1", role: "assistant", text: "cold start", model: "m-a", costUsd: 0.01 },
				{ id: "u1", role: "user", text: "next" },
				{ id: "a2", role: "assistant", text: "ttl miss", model: "m-a", costUsd: 0.012 },
				{ id: "u2", role: "user", text: "next" },
				{ id: "a3", role: "assistant", text: "prefix miss", model: "m-a", costUsd: 0.011 },
				{ id: "u3", role: "user", text: "next" },
				{ id: "a4", role: "assistant", text: "hit", model: "m-a", costUsd: 0.002 },
			]);
			// usage per assistant turn
			await setUsage(t.db, "a1", { input: 30000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 30100 }); // cold-start
			await setUsage(t.db, "a2", { input: 30000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 30100 }); // gap 360 > 300 → ttl
			await setUsage(t.db, "a3", { input: 30000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 30100 }); // gap 10 → prefix
			await setUsage(t.db, "a4", { input: 1000, output: 50, cacheRead: 9000, cacheWrite: 1000, totalTokens: 11050 }); // write + read → churn? read later none but hit
			await setTimestamps(t.db, sid, { a1: 1_700_000_000, a2: 1_700_000_360, a3: 1_700_000_370, a4: 1_700_000_380 });

			const mock = createMockLLM({ responder: () => "{}", tokensPerCall: 0, costPerCall: 0 });
			const fw = new AnalyzerFramework({ db: t.db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			const { errors } = await registerAll(fw, { builtins: [cacheEconomyAnalyzer] });
			assert.deepEqual(errors, [], JSON.stringify(errors));

			const summary = await fw.run(sid, { analyzerIds: ["cache-economy"] });
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			const row = await t.db
				.prepare("SELECT content_json, node_kind FROM analysis_nodes WHERE analyzer_id = 'cache-economy'")
				.get() as { content_json: string; node_kind: string } | undefined;
			assert.ok(row, "produced a node");
			assert.equal(row!.node_kind, "proposal", "cold misses exist → proposal node");
			const c = JSON.parse(row!.content_json);

			// classifications
			assert.equal(c.turns[0].classification, "cold-start");
			assert.equal(c.turns[1].classification, "cold-ttl");
			assert.equal(c.turns[2].classification, "cold-prefix");
			// a4: 9000 / (9000 + 1000 + 1000) = 0.818 → hit
			assert.equal(c.turns[3].classification, "hit");

			// coverage
			assert.equal(c.usage_recorded_turn_count, 4);
			assert.equal(c.priced_turn_count, 4);
			assert.equal(c.unpriced_turn_count, 0);

			// aggregate: read 9000 / (9000 + 1000 + 61000) = 9000/71000 ≈ 0.1268
			assert.equal(c.aggregate_cache_read_tokens, 9000);
			assert.equal(c.aggregate_cache_write_tokens, 1000);
			assert.equal(c.aggregate_input_tokens, 91000);
			assert.ok(Math.abs(c.aggregate_hit_ratio - 9000 / 101000) < 1e-9);

			// cold-miss dollar lower bound = sum of a2 + a3 = 0.023
			assert.equal(c.cold_turn_count, 2);
			assert.equal(c.cold_priced_turn_count, 2);
			assert.ok(Math.abs(c.cold_miss_cost_usd - 0.023) < 1e-9);

			// write churn: a4 wrote 1000 and no later read → churned; others wrote 0
			assert.equal(c.write_churn_tokens, 1000);

			// proposals
			assert.ok(Array.isArray(c.improvement_proposals));
			assert.ok(c.improvement_proposals.some((p: { title: string }) => p.title.includes("Cold prompt cache")));
			assert.ok(c.improvement_proposals.some((p: { title: string }) => p.title.includes("TTL expiry")));
			assert.ok(c.improvement_proposals.some((p: { title: string }) => p.title.includes("Prefix instability")));
			assert.ok(c.improvement_proposals.some((p: { title: string }) => p.title.includes("Write churn")));
		} finally {
			t.close();
		}
	});

	it("emits only a metric node for a session with healthy cache hits", async () => {
		const t: TempDb = await tempDb();
		try {
			const sid = "ce2";
			await insertSession(t.db, sid);
			await insertMessages(t.db, sid, [
				{ id: "u0", role: "user", text: "start" },
				{ id: "a1", role: "assistant", text: "hit 1", model: "m-a", costUsd: 0.001 },
				{ id: "a2", role: "assistant", text: "hit 2", model: "m-a", costUsd: 0.001 },
			]);
			await setUsage(t.db, "a1", { input: 1000, output: 50, cacheRead: 9000, cacheWrite: 0, totalTokens: 10050 });
			await setUsage(t.db, "a2", { input: 1000, output: 50, cacheRead: 9000, cacheWrite: 0, totalTokens: 10050 });

			const mock = createMockLLM({ responder: () => "{}", tokensPerCall: 0, costPerCall: 0 });
			const fw = new AnalyzerFramework({ db: t.db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			const { errors } = await registerAll(fw, { builtins: [cacheEconomyAnalyzer] });
			assert.deepEqual(errors, [], JSON.stringify(errors));

			await fw.run(sid, { analyzerIds: ["cache-economy"] });

			const row = await t.db
				.prepare("SELECT content_json, node_kind FROM analysis_nodes WHERE analyzer_id = 'cache-economy'")
				.get() as { content_json: string; node_kind: string } | undefined;
			assert.ok(row);
			assert.equal(row!.node_kind, "metric", "healthy session → metric node, no proposal");
			const c = JSON.parse(row!.content_json);
			assert.equal(c.improvement_proposals.length, 0);
			assert.equal(c.turns[0].classification, "hit");
		} finally {
			t.close();
		}
	});

	it("distinguishes an unbilled turn from a measured zero", async () => {
		const t: TempDb = await tempDb();
		try {
			const sid = "ce3";
			await insertSession(t.db, sid);
			await insertMessages(t.db, sid, [
				{ id: "u0", role: "user", text: "start" },
				{ id: "a1", role: "assistant", text: "unbilled", model: "m-a" }, // no usage → unbilled
				{ id: "a2", role: "assistant", text: "measured zero", model: "m-a" },
			]);
			// a2 records usage with all-zero buckets except a small input → measured cold, not absent
			await setUsage(t.db, "a2", { input: 30000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30010 });

			const mock = createMockLLM({ responder: () => "{}", tokensPerCall: 0, costPerCall: 0 });
			const fw = new AnalyzerFramework({ db: t.db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			await registerAll(fw, { builtins: [cacheEconomyAnalyzer] });
			await fw.run(sid, { analyzerIds: ["cache-economy"] });

			const row = await t.db
				.prepare("SELECT content_json FROM analysis_nodes WHERE analyzer_id = 'cache-economy'")
				.get() as { content_json: string } | undefined;
			const c = JSON.parse(row!.content_json);
			assert.equal(c.usage_recorded_turn_count, 1, "only the measured turn counts as recorded");
			assert.equal(c.unbilled_turn_count, 1, "the no-usage turn is unbilled, not zero");
		} finally {
			t.close();
		}
	});
});
