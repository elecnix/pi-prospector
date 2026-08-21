/**
 * Every computed node records how long it took wall-clock (duration_ms) and,
 * for LLM-backed nodes, the token count of its inference split into input /
 * cached input / output. These are execution metrics, not identity inputs --
 * they never feed input_key/output_key, but they are persisted on the node so
 * a consumer can read what a node truly cost.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { getNodesByAnalyzer } from "../../src/db/analysis-queries.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import type { Analyzer, AnalysisResult, AnalyzerRunContext } from "../../src/analyze/types.js";

async function seed(db: AsyncDatabase, sessionId = "s1"): Promise<void> {
	await insertSession(db, sessionId);
	await insertMessages(db, sessionId, [{ role: "user", text: "hello" }]);
}

describe("node compute cost & wall-clock timing", () => {
	it("records the wall-clock duration on deterministic nodes (no LLM costs)", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db);
			// A slow deterministic analyzer. It never calls the LLM, so its token
			// split must stay null -- but it must still carry a measured wall-clock
			// duration_ms, recorded by the framework boundary not by itself.
			const slow: Analyzer = {
				def: { id: "slow", label: "Slow", description: "", anchorSpan: "full_session", dependencies: [] },
				version: { analyzerId: "slow", major: 1, minor: 0, implementationKind: "deterministic" },
				prompts: {},
				defaultConfig: { id: "", analyzerId: "slow", configHash: "h", configJson: {} },
				plan: () => [{ sources: [{ kind: "session", id: "s1" }], sourceSetHash: "ssh", anchorKind: "session", anchorRef: "s1" }],
				analyze: async (): Promise<AnalysisResult> => {
					await new Promise((r) => setTimeout(r, 20));
					return { nodeKind: "metric", contentJson: { ok: true }, anchorKind: "session", anchorRef: "s1", edges: [] };
				},
			};
			const framework = new AnalyzerFramework({ db, llm: createMockLLM().caller, modelTiers: DEFAULT_MODEL_TIERS });
			await framework.register(slow);

			await framework.run("s1");
			const nodes = await getNodesByAnalyzer(db, "slow", "s1");
			assert.equal(nodes.length, 1);
			assert.equal(typeof nodes[0]!.duration_ms, "number");
			assert.ok(nodes[0]!.duration_ms! >= 10, `wall-clock elapsed should be recorded, got ${nodes[0]!.duration_ms}`);
			assert.equal(nodes[0]!.input_tokens, null, "no LLM called -> no input tokens");
			assert.equal(nodes[0]!.cached_input_tokens, null);
			assert.equal(nodes[0]!.output_tokens, null);
		} finally {
			await close();
		}
	});

	it("records the token split (input / cached input / output) on LLM nodes", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db);
			const mock = createMockLLM({
				responder: () => ({
					text: "x",
					model: "anthropic/clip",
					costUsd: 0.01,
					tokensUsed: 200,
					inputTokens: 100,
					cachedInputTokens: 30,
					outputTokens: 70,
				}),
			});
			const llm: Analyzer = {
				def: { id: "llm", label: "LLM", description: "", anchorSpan: "full_session", dependencies: [] },
				version: { analyzerId: "llm", major: 1, minor: 0, implementationKind: "in_process_llm" },
				prompts: {},
				defaultConfig: { id: "", analyzerId: "llm", configHash: "h", configJson: {} },
				plan: () => [{ sources: [{ kind: "session", id: "s1" }], sourceSetHash: "ssh", anchorKind: "session", anchorRef: "s1" }],
				analyze: async (_unit, ctx: AnalyzerRunContext): Promise<AnalysisResult> => {
					await new Promise((r) => setTimeout(r, 5));
					const res = await ctx.llm({ model: "cheap", user: "x" });
					return {
						nodeKind: "classification",
						contentJson: { ok: true },
						anchorKind: "session",
						anchorRef: ctx.sessionId,
						modelUsed: res.model,
						costUsd: res.costUsd,
						tokensUsed: res.tokensUsed,
						inputTokens: res.inputTokens,
						cachedInputTokens: res.cachedInputTokens,
						outputTokens: res.outputTokens,
						edges: [],
					};
				},
				modelsForIdentity: () => ["anthropic/clip"],
			};
			const framework = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			await framework.register(llm);

			await framework.run("s1");
			const nodes = await getNodesByAnalyzer(db, "llm", "s1");
			assert.equal(nodes.length, 1);
			const n = nodes[0]!;
			assert.equal(n.tokens_used, 200, "total token count is preserved");
			assert.equal(n.input_tokens, 100);
			assert.equal(n.cached_input_tokens, 30);
			assert.equal(n.output_tokens, 70);
			// The three buckets reconcile to the total the provider billed.
			assert.equal(n.input_tokens! + n.cached_input_tokens! + n.output_tokens!, n.tokens_used!);
			assert.equal(typeof n.duration_ms, "number");
			assert.ok(n.duration_ms! >= 0, "LLM node still records measured wall-clock");
		} finally {
			await close();
		}
	});
});
