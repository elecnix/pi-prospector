/**
 * Units within one analyzer run concurrently.
 *
 * Sessions were the only axis of fan-out: `runAnalyzer` awaited each unit in
 * turn, so a session could never have more than one call in flight no matter
 * how the limits were set. Measured over a real corpus at 40-way session
 * concurrency, that left the LLM gate ~30% utilised — many lanes were busy with
 * deterministic work and issuing no calls at all — and `--session X` on its own
 * ran at concurrency 1 regardless of any flag.
 *
 * The global semaphore around the LLM caller remains the ceiling on provider
 * load; this only lets a single session actually reach it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { lexiconCandidatesAnalyzer } from "../../src/analyze/analyzers/lexicon-candidates/index.js";
import { frustrationLexiconAnalyzer, FRUSTRATION_LEXICON_DEF } from "../../src/analyze/analyzers/frustration-lexicon/index.js";
import { getNodesByAnalyzer } from "../../src/db/analysis-queries.js";
import type { LLMRequest, LLMResponse } from "../../src/analyze/types.js";

/** Distinct, digit-free vocabulary — digits are dropped by the shape filter. */
function words(prefix: string, count: number): string[] {
	const letter = (n: number): string => String.fromCharCode(97 + (n % 26));
	return Array.from({ length: count }, (_, i) => `${prefix}${letter(Math.floor(i / 26))}${letter(i)}`);
}

/**
 * Single-word verdict nodes only. Since #40 nomination also puts forward
 * two-word phrases, which this suite's seeded prose duly produces; they ride
 * the same pipeline and would otherwise inflate these exact-count pins.
 */
function wordNodes(db: Parameters<typeof getNodesByAnalyzer>[0], sessionId: string) {
	return getNodesByAnalyzer(db, FRUSTRATION_LEXICON_DEF.id, sessionId).then((nodes) =>
		nodes.map((n) => (JSON.parse(n.content_json) as { term: string }).term).filter((t) => !t.includes(" ")),
	);
}

/** An LLM stub that records how many calls are in flight at once. */
function trackingLLM(delayMs = 5) {
	let inFlight = 0;
	let peak = 0;
	const caller = async (_req: LLMRequest): Promise<LLMResponse> => {
		inFlight++;
		peak = Math.max(peak, inFlight);
		await new Promise((r) => setTimeout(r, delayMs));
		inFlight--;
		return {
			text: "x",
			structured: { polarity: "neutral", category: "none", language: "und", confidence: 0.9, rationale: "r" },
			model: "m",
			costUsd: 0,
			tokensUsed: 0,
			durationMs: delayMs,
			stopReason: "stop",
		};
	};
	return { caller, peak: () => peak };
}

async function seed(db: Parameters<typeof getNodesByAnalyzer>[0], sessionId: string, vocab: string[]): Promise<void> {
	await insertSession(db, sessionId);
	await insertMessages(db, sessionId, [{ role: "user", text: vocab.join(" ") }]);
}

describe("intra-analyzer parallelism", () => {
	it("runs a single session's units concurrently", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "s1", words("alpha", 30));
			const llm = trackingLLM();
			const framework = new AnalyzerFramework({
				db,
				llm: llm.caller,
				modelTiers: DEFAULT_MODEL_TIERS,
				unitConcurrency: 8,
			});
			await framework.register(lexiconCandidatesAnalyzer);
			await framework.register(frustrationLexiconAnalyzer);
			await framework.run("s1");

			assert.ok(
				llm.peak() > 1,
				`one session must reach past concurrency 1; peak in-flight was ${llm.peak()}`,
			);
			assert.ok(llm.peak() <= 8, `must respect the configured limit; peak was ${llm.peak()}`);
			assert.equal((await wordNodes(db, "s1")).length, 30);
		} finally {
			await close();
		}
	});

	it("defaults to sequential so existing behaviour is opt-in to change", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "s1", words("beta", 10));
			const llm = trackingLLM();
			const framework = new AnalyzerFramework({ db, llm: llm.caller, modelTiers: DEFAULT_MODEL_TIERS });
			await framework.register(lexiconCandidatesAnalyzer);
			await framework.register(frustrationLexiconAnalyzer);
			await framework.run("s1");
			assert.equal((await wordNodes(db, "s1")).length, 10);
		} finally {
			await close();
		}
	});

	it("still produces exactly one node per unit, with no duplicates", async () => {
		const { db, close } = await tempDb();
		try {
			const vocab = words("gamma", 40);
			await seed(db, "s1", vocab);
			const llm = trackingLLM(1);
			const framework = new AnalyzerFramework({
				db, llm: llm.caller, modelTiers: DEFAULT_MODEL_TIERS, unitConcurrency: 16,
			});
			await framework.register(lexiconCandidatesAnalyzer);
			await framework.register(frustrationLexiconAnalyzer);
			const summary = await framework.run("s1");

			assert.equal(summary.errors.length, 0);
			const terms = await wordNodes(db, "s1");
			assert.equal(terms.length, vocab.length);
			assert.equal(new Set(terms).size, terms.length, "no term judged twice");
		} finally {
			await close();
		}
	});

	it("re-running remains a no-op", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "s1", words("delta", 20));
			const llm = trackingLLM(1);
			const framework = new AnalyzerFramework({
				db, llm: llm.caller, modelTiers: DEFAULT_MODEL_TIERS, unitConcurrency: 8,
			});
			await framework.register(lexiconCandidatesAnalyzer);
			await framework.register(frustrationLexiconAnalyzer);
			await framework.run("s1");
			const again = await framework.run("s1");
			assert.equal(again.nodesProduced, 0, "idempotency must survive concurrency");
		} finally {
			await close();
		}
	});

	it("a configuration fault still stops the analyzer instead of failing every unit", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "s1", words("epsilon", 40));
			let calls = 0;
			const llm = async (): Promise<LLMResponse> => {
				calls++;
				await new Promise((r) => setTimeout(r, 1));
				throw new Error("Model not found in Pi registry: nope/nope. Configure it via Pi or set modelTiers in prospector.json.");
			};
			const framework = new AnalyzerFramework({
				db, llm, modelTiers: DEFAULT_MODEL_TIERS, unitConcurrency: 4,
			});
			await framework.register(lexiconCandidatesAnalyzer);
			await framework.register(frustrationLexiconAnalyzer);
			const summary = await framework.run("s1");

			assert.ok(summary.errors.length > 0);
			// In-flight units still finish, so the bound is the concurrency width —
			// not one, but nowhere near the 40 a per-unit failure would produce.
			assert.ok(calls <= 8, `expected the run to stop early, got ${calls} calls`);
		} finally {
			await close();
		}
	});
});
