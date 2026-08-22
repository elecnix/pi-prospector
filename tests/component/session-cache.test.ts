import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createThrowingLLM } from "../../src/analyze/mock-llm.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";
import type {
	Analyzer,
	AnalysisResult,
	AnalyzerPlanContext,
	AnalyzerRunContext,
} from "../../src/analyze/types.js";

function frameworkFor(db: AsyncDatabase): AnalyzerFramework {
	return new AnalyzerFramework({ db, llm: createThrowingLLM(), modelTiers: DEFAULT_MODEL_TIERS });
}

async function seedSession(db: AsyncDatabase, id = "s1"): Promise<void> {
	await insertSession(db, id);
	await insertMessages(db, id, [
		{ role: "user", text: "fix the login bug" },
		{ role: "assistant", text: "looking", toolCalls: [{ name: "read" }] },
		{ role: "toolResult", toolResults: [{ toolName: "read", isError: true, textLength: 50 }] },
		{ role: "user", text: "no, that's wrong, use the auth module" },
		{ role: "assistant", text: "fixing" },
	]);
}

function unitAnalyzer(id: string, deps: string[]): Analyzer {
	return {
		def: { id, label: id, description: "", anchorSpan: "full_session", dependencies: deps },
		version: { analyzerId: id, major: 1, minor: 0, implementationKind: "deterministic" },
		prompts: {},
		defaultConfig: { id: "", analyzerId: id, configHash: "h", configJson: {}, label: "default" },
		plan: (_ctx: AnalyzerPlanContext) => [
			{ sources: [{ kind: "session" as const, id: "s1" }], sourceSetHash: `${id}-ssh`, anchorKind: "session" as const, anchorRef: "s1" },
		],
		analyze: (_unit: unknown, _ctx: AnalyzerRunContext): AnalysisResult =>
			({ nodeKind: "metric", contentJson: { id }, anchorKind: "session", anchorRef: "s1", edges: [] }),
	};
}

describe("session-scoped input cache (#57)", () => {
	it("shares messages and turn pairs across analyzers, keyed by session id", async () => {
		const { db, close } = await tempDb();
		try {
			await seedSession(db);
			// A distinct sibling session with different content: the keyed cache must
			// never hand its pairs to the current session's lookup (or vice versa).
			await insertSession(db, "other");
			await insertMessages(db, "other", [{ role: "user", text: "completely unrelated" }, { role: "assistant", text: "ok" }]);

			const seen: Record<string, unknown> = {};
			const mk = (id: string): Analyzer => ({
				def: { id, label: id, description: "", anchorSpan: "full_session", dependencies: [] },
				version: { analyzerId: id, major: 1, minor: 0, implementationKind: "deterministic" },
				prompts: {},
				defaultConfig: { id: "", analyzerId: id, configHash: "h", configJson: {}, label: "default" },
				plan: async (ctx: AnalyzerPlanContext) => {
					seen[`${id}.plan.messages`] = ctx.messages;
					seen[`${id}.plan.pairs`] = await ctx.getTurnPairs(ctx.sessionId);
					seen[`${id}.plan.otherPairs`] = await ctx.getTurnPairs("other");
					return [
						{ sources: [{ kind: "session" as const, id: ctx.sessionId }], sourceSetHash: `${id}-ssh`, anchorKind: "session" as const, anchorRef: ctx.sessionId },
					];
				},
				analyze: async (unit: never, ctx: AnalyzerRunContext): Promise<AnalysisResult> => {
					seen[`${id}.run.pairs`] = await ctx.getTurnPairs(ctx.sessionId);
					return { nodeKind: "metric", contentJson: { id }, anchorKind: "session", anchorRef: ctx.sessionId, edges: [] };
				},
			});

			const fw = frameworkFor(db);
			await fw.register(mk("A"));
			await fw.register(mk("B"));
			await fw.run("s1", {});

			// Messages are loaded once and shared by reference across analyzers.
			assert.equal(seen["A.plan.messages"], seen["B.plan.messages"], "messages array must be shared (loaded once)");
			// Turn pairs are computed once and shared across plan + run of every analyzer.
			assert.equal(seen["A.plan.pairs"], seen["B.plan.pairs"], "plan pairs must be the same cached array");
			assert.equal(seen["A.plan.pairs"], seen["A.run.pairs"], "run context must reuse the plan's pairs");
			// A sibling session gets its OWN pair array — never the current session's.
			assert.equal(seen["A.plan.otherPairs"], seen["B.plan.otherPairs"], "sibling key must be cached consistently");
			assert.notEqual(seen["A.plan.otherPairs"], seen["A.plan.pairs"], "sibling pairs must never be the current session's pairs");
			const otherAsSibling = seen["A.plan.otherPairs"] as Array<{ userText: string }>;
			assert.ok(otherAsSibling.length === 1 && otherAsSibling[0]!.userText.includes("unrelated"), "sibling key returned that sibling's pairs");
		} finally {
			await close();
		}
	});

	it("a later analyzer in the same run sees a dependency's freshly written node", async () => {
		const { db, close } = await tempDb();
		try {
			await seedSession(db);
			let consumerSawDep: boolean;
			const producer = unitAnalyzer("producer", []);
			const consumer: Analyzer = {
				...unitAnalyzer("consumer", ["producer"]),
				plan: (ctx: AnalyzerPlanContext) => {
					// producer ran before consumer (topological order); its node must be
					// present here, which only holds if the session node cache was
					// invalidated when producer wrote.
					consumerSawDep = (ctx.dependencyNodes["producer"] ?? []).some((n) => n.analyzer_id === "producer");
					return [
						{ sources: [{ kind: "session" as const, id: "s1" }], sourceSetHash: "consumer-ssh", anchorKind: "session" as const, anchorRef: "s1" },
					];
				},
			};

			const fw = frameworkFor(db);
			await fw.register(producer);
			await fw.register(consumer);
			await fw.run("s1", {});

			assert.ok(consumerSawDep, "consumer must see producer's node written earlier in the same run");
			const n = (await db.prepare("SELECT COUNT(*) c FROM analysis_nodes WHERE analyzer_id='producer'").get()) as { c: number };
			assert.equal(n.c, 1, "producer actually wrote one node");
		} finally {
			await close();
		}
	});
});
