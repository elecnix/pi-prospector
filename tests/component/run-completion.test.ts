import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import {
	mapWithConcurrency,
	withTimeout,
	callWithRetry,
	classifyRetryable,
	DEFAULT_RETRY_POLICY,
	type RetryPolicy,
	type RetryStats,
} from "../../src/analyze/concurrency.js";
import { accountResults, accountOne, emptyAccounting, runStatus } from "../../src/analyze/run-accounting.js";
import {
	createAnalyzeRun,
	finalizeAnalyzeRun,
	getLatestAnalyzeRuns,
} from "../../src/db/analysis-queries.js";
import { tempDb, insertSession } from "./helpers.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import type { Analyzer, LLMCaller, AnalysisUnit } from "../../src/analyze/types.js";

/**
 * A minimal deterministic-LLM analyzer: exactly one LLM call per session, then a
 * metric node. Used to prove the overlay's terminal-state contract without the
 * full built-in analyzer surface.
 */
function llmAnalyzer(id: string): Analyzer {
	return {
		def: { id, label: id, description: "one call per session", anchorSpan: "full_session", dependencies: [] },
		version: { analyzerId: id, major: 1, minor: 0, implementationKind: "llm" },
		prompts: {},
		defaultConfig: { id: "", analyzerId: id, configHash: "h", configJson: {}, label: "default" },
		plan: (ctx) =>
			[
				{
					sources: [{ kind: "session", id: ctx.sessionId }],
					sourceSetHash: `${id}-ssh`,
					anchorKind: "session",
					anchorRef: ctx.sessionId,
				},
			] as AnalysisUnit[],
		analyze: async (unit, ctx) => {
			await ctx.llm({ model: "cheap", system: "prompt", user: "payload" });
			return {
				nodeKind: "metric",
				contentJson: { value: 1 },
				anchorKind: "session",
				anchorRef: unit.anchorRef,
				edges: [],
				costUsd: 0.001,
				tokensUsed: 5,
			};
		},
		modelsForIdentity: () => ["anthropic/c"],
	};
}

describe("whole-run completion record + terminal state", () => {
	it("persists a run record that starts 'running' and finalizes with real counts", () => {
		const { db, close } = tempDb();
		try {
			createAnalyzeRun(db, { id: "run-1", mode: "fill", sessionAttempted: 320 });
			let row = getLatestAnalyzeRuns(db, 1)[0] as Record<string, unknown>;
			assert.equal(row.status, "running");
			assert.equal(row.session_attempted, 320);

			finalizeAnalyzeRun(db, "run-1", {
				status: "partial",
				sessionCompleted: 312,
				sessionFailed: 8,
				retried: 14,
				nodesProduced: 1000,
				nodesRevised: 2,
				proposalsCreated: 5,
				costUsd: 1.25,
				tokensUsed: 10_000,
				errorCount: 12,
				errorExamples: ["turn-pair-llm: …timed out…"],
			});
			row = getLatestAnalyzeRuns(db, 1)[0] as Record<string, unknown>;
			assert.equal(row.status, "partial");
			assert.equal(row.session_completed, 312);
			assert.equal(row.session_failed, 8);
			assert.equal(row.retried, 14);
			assert.ok(row.finished_at, "should be timestamped when finalized");
			const examples = JSON.parse(String(row.error_examples)) as string[];
			assert.deepEqual(examples, ["turn-pair-llm: …timed out…"]);
		} finally {
			close();
		}
	});

	it("a hung LLM call fails that session and the run still reaches a terminal state", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s-hang");
			insertSession(db, "s-good");

			const fw = new AnalyzerFramework({
				db,
				llm: () => Promise.resolve({ text: "x", model: "anthropic/c", costUsd: 0.001, tokensUsed: 5 }),
				modelTiers: DEFAULT_MODEL_TIERS,
			});
			fw.register(llmAnalyzer("one-shot"));

			// Mirrors analyze.ts: wrap every LLM call with withTimeout so a provider
			// call that neither resolves nor rejects becomes a terminal error.
			const sessions = ["s-hang", "s-good"];
			let callIndex = 0;
			const baseLlm: LLMCaller = async () => {
				const i = callIndex++;
				// The very first call represents the stalled provider: it never settles.
				if (i === 0) await new Promise<never>(() => {});
				return { text: "x", model: "anthropic/c", costUsd: 0.001, tokensUsed: 5 };
			};
			const timeoutMs = 120;
			const llm: LLMCaller = (req) =>
				withTimeout(baseLlm(req), timeoutMs, () => new Error(`LLM call to ${req.model} exceeded ${timeoutMs}ms`));

			const fwBounded = new AnalyzerFramework({ db, llm, modelTiers: DEFAULT_MODEL_TIERS });
			fwBounded.register(llmAnalyzer("one-shot"));

			let accounting = emptyAccounting();
			// Sequential fan-out (concurrency 1) so call order == session order, making
			// the hang deterministically the first session.
			await mapWithConcurrency(sessions, 1, async (sessionId) => {
				const summary = await fwBounded.run(sessionId, {});
				accounting = accountOne(
					accounting,
					summary.errors.length === 0
						? { ok: true, nodesProduced: summary.nodesProduced, nodesRevised: 0, proposalsCreated: summary.proposalsCreated, costUsd: summary.costUsd, tokensUsed: summary.tokensUsed, errors: [] }
						: { ok: false, nodesProduced: 0, nodesRevised: 0, proposalsCreated: 0, costUsd: 0, tokensUsed: 0, errors: summary.errors },
				);
			});

			// Terminal state: both sessions resolved, no hang.
			assert.equal(accounting.attempted, 2, "both sessions processed (run terminated)");
			assert.equal(accounting.completed, 1, "good session completed");
			assert.equal(accounting.failed, 1, "hung session failed instead of stalling the run");
			assert.equal(accounting.errorCount, 1);
			assert.equal(runStatus(accounting), "partial");
			assert.match(accounting.errorExamples[0] ?? "", /exceeded 120ms/);
		} finally {
			close();
		}
	});

	it("retries a throttled (429) LLM call, completes the session, and records the retry", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s-throttled");

			// baseLlm fails the first calls with a status-bearing 429 (as a provider
			// error looks after its own internal retries are spent) then succeeds.
			const retryable = Object.assign(new Error("429 Too Many Requests"), { status: 429 });
			let calls = 0;
			const baseLlm: LLMCaller = async () => {
				calls++;
				if (calls <= 2) throw retryable;
				return { text: "ok", model: "anthropic/c", costUsd: 0.001, tokensUsed: 5 };
			};

			// Mirrors analyze.ts: a bounded retry layer wrapped around the caller.
			const retryPolicy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, isRetryable: classifyRetryable };
			const retryStats: RetryStats = { retries: 0 };
			const llm: LLMCaller = (req) => callWithRetry(() => baseLlm(req), retryPolicy, retryStats);

			const fw = new AnalyzerFramework({ db, llm, modelTiers: DEFAULT_MODEL_TIERS });
			fw.register(llmAnalyzer("one-shot"));

			let accounting = emptyAccounting();
			await mapWithConcurrency(["s-throttled"], 1, async (sessionId) => {
				const summary = await fw.run(sessionId, {});
				accounting = accountOne(
					accounting,
					summary.errors.length === 0
						? { ok: true, nodesProduced: summary.nodesProduced, nodesRevised: 0, proposalsCreated: summary.proposalsCreated, costUsd: summary.costUsd, tokensUsed: summary.tokensUsed, errors: [] }
						: { ok: false, nodesProduced: 0, nodesRevised: 0, proposalsCreated: 0, costUsd: 0, tokensUsed: 0, errors: summary.errors },
				);
			});

			// The throttle was absorbed: the session completed instead of failing.
			assert.equal(accounting.completed, 1);
			assert.equal(accounting.failed, 0);
			assert.equal(retryStats.retries, 2);
			assert.equal(calls, 3);

			// The run record persists the retries so the next person can tell
			// "throttled and recovered" from "throttled and gave up".
			createAnalyzeRun(db, { id: "run-throttle", mode: "fill", sessionAttempted: 1 });
			finalizeAnalyzeRun(db, "run-throttle", {
				status: runStatus(accounting),
				sessionCompleted: accounting.completed,
				sessionFailed: accounting.failed,
				retried: retryStats.retries,
				nodesProduced: accounting.nodesProduced,
				nodesRevised: accounting.nodesRevised,
				proposalsCreated: accounting.proposalsCreated,
				costUsd: accounting.costUsd,
				tokensUsed: accounting.tokensUsed,
				errorCount: accounting.errorCount,
				errorExamples: accounting.errorExamples,
			});
			const row = getLatestAnalyzeRuns(db, 1)[0] as Record<string, unknown>;
			assert.equal(row.status, "ok");
			assert.equal(row.retried, retryStats.retries);
		} finally {
			close();
		}
	});

	it("accountResults aggregates outcomes and status reflects a clean run", () => {
		const acc = accountResults(emptyAccounting(), [
			{ ok: true, nodesProduced: 4, nodesRevised: 0, proposalsCreated: 2, costUsd: 0.5, tokensUsed: 10, errors: [] },
			{ ok: true, nodesProduced: 3, nodesRevised: 1, proposalsCreated: 1, costUsd: 0.25, tokensUsed: 8, errors: [] },
		]);
		assert.equal(acc.attempted, 2);
		assert.equal(acc.completed, 2);
		assert.equal(acc.failed, 0);
		assert.equal(acc.nodesProduced, 7);
		assert.equal(acc.proposalsCreated, 3);
		assert.equal(runStatus(acc), "ok");
	});
});
