import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { turnPairLLMAnalyzer } from "../../src/analyze/analyzers/turn-pair-llm/index.js";
import { DEFAULT_MODEL_TIERS, applyModelOverride } from "../../src/analyze/model-tiers.js";
import { getNodeVersions, getRevisedNode } from "../../src/db/analysis-queries.js";
import type { LLMRequest, ModelTierConfig } from "../../src/analyze/types.js";

// turn-pair-llm only ever sends a classify prompt; return a fixed classification.
function respond(_req: LLMRequest): string {
	if (_req.tool?.name === "classify_term") {
		return JSON.stringify({ polarity: "neutral", category: "none", language: "und", confidence: 0.9, rationale: "ordinary vocabulary" });
	}
	return JSON.stringify({
		sentiment: "frustrated",
		friction_type: "wrong_approach",
		is_genuine_correction: true,
		severity: "high",
		rationale: "user corrected the approach",
	});
}

async function seedSession(db: AsyncDatabase, id = "s1"): Promise<void> {
	await insertSession(db, id);
	await insertMessages(db, id, [
		{ role: "user", text: "fix the login bug" },
		{ role: "assistant", text: "reading auth", toolCalls: [{ name: "read" }] },
		{ role: "toolResult", toolResults: [{ toolName: "read", isError: true, textLength: 80 }] },
		{ role: "user", text: "no, that's wrong, use the auth module instead" },
		{ role: "assistant", text: "understood, fixing now" },
	]);
}

async function frameworkFor(
	db: AsyncDatabase,
	modelTiers: ModelTierConfig,
): Promise<AnalyzerFramework> {
	const mock = createMockLLM({ responder: respond, tokensPerCall: 50, costPerCall: 0.001 });
	const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers });
	await fw.register(turnPairCoreAnalyzer);
	await fw.register(turnPairLLMAnalyzer);
	return fw;
}

// A tier mapping that differs from the default only in what `cheap` resolves to.
const REMAPPED_TIERS: ModelTierConfig = { ...DEFAULT_MODEL_TIERS, cheap: "openai/gpt-5-mini" };

async function classificationNodes(db: AsyncDatabase) {
	return (await db
		.prepare("SELECT * FROM analysis_nodes WHERE analyzer_id = 'turn-pair-llm' ORDER BY created_at ASC, rowid ASC")
		.all()) as Array<{ id: string; source_set_hash: string }>;
}

describe("the resolved model is part of a node's config identity", () => {
	it("remapping a tier to a new model marks the LLM node stale (config reason); core stays current", async () => {
		const { db, close } = await tempDb();
		try {
			await seedSession(db);

			// First pass: default tiers (cheap = the default model).
			await (await frameworkFor(db, DEFAULT_MODEL_TIERS)).run("s1", {});
			assert.equal((await classificationNodes(db)).length, 1, "one classification produced initially");

			// Re-scan with a different concrete model for the `cheap` tier.
			const remapped = await frameworkFor(db, REMAPPED_TIERS);
			const classified = await remapped.scan("s1");

			const llm = classified.filter((c) => c.analyzerId === "turn-pair-llm");
			const core = classified.filter((c) => c.analyzerId === "turn-pair-core");
			assert.ok(llm.length >= 1);
			assert.ok(llm.every((c) => c.status === "stale"), "model change makes the LLM unit stale");
			assert.ok(
				llm.every((c) => c.reasons.includes("config") && !c.reasons.includes("major") && !c.reasons.includes("minor")),
				"a model swap is an ungraded config reason, not a version bump",
			);
			assert.ok(core.every((c) => c.status === "current"), "deterministic core is unaffected by model change");
		} finally {
			await close();
		}
	});

	it("a plain fill leaves the stale (model-changed) node untouched; --revise config revises it", async () => {
		const { db, close } = await tempDb();
		try {
			await seedSession(db);
			await (await frameworkFor(db, DEFAULT_MODEL_TIERS)).run("s1", {});
			const before = await classificationNodes(db);
			assert.equal(before.length, 1);
			const sourceSetHash = before[0]!.source_set_hash;

			// A plain fill under the new model must NOT touch the stale node (cost-safe).
			const fill = await (await frameworkFor(db, REMAPPED_TIERS)).run("s1", {});
			assert.equal(fill.nodesRevised, 0);
			assert.equal((await classificationNodes(db)).length, 1, "a fill does not re-run a stale model change");

			// --revise config produces a NEW version linked to the old one by a revises edge.
			const revised = await (await frameworkFor(db, REMAPPED_TIERS)).run("s1", { revise: ["config"] });
			assert.ok(revised.nodesRevised >= 1, "revise config revises the model-changed node");

			const after = await classificationNodes(db);
			assert.equal(after.length, 2, "old and new versions coexist");

			const versions = await getNodeVersions(db, "turn-pair-llm", sourceSetHash);
			assert.equal(versions.length, 2);

			const newest = versions[versions.length - 1]!;
			const revisedNode = await getRevisedNode(db, newest.id);
			assert.ok(revisedNode, "newest version revises an older one");
			assert.equal(revisedNode!.id, before[0]!.id);
		} finally {
			await close();
		}
	});

	it("re-running with the same tier mapping is idempotent (no model churn)", async () => {
		const { db, close } = await tempDb();
		try {
			await seedSession(db);
			await (await frameworkFor(db, DEFAULT_MODEL_TIERS)).run("s1", {});
			const revised = await (await frameworkFor(db, DEFAULT_MODEL_TIERS)).run("s1", { revise: ["major", "minor", "config"] });
			assert.equal(revised.nodesRevised, 0, "unchanged model means nothing is stale");
			assert.equal((await classificationNodes(db)).length, 1);
		} finally {
			await close();
		}
	});
});

describe("--model override is live (the pinned model is actually used)", () => {
	it("passes the pinned concrete model to the LLM and records it on the node", async () => {
		const { db, close } = await tempDb();
		try {
			await seedSession(db);
			const pinned = "openai/gpt-5-override";
			const effectiveTiers = applyModelOverride(DEFAULT_MODEL_TIERS, pinned);

			const mock = createMockLLM({ responder: respond, tokensPerCall: 50, costPerCall: 0.001 });
			const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: effectiveTiers });
			await fw.register(turnPairCoreAnalyzer);
			await fw.register(turnPairLLMAnalyzer);
			await fw.run("s1", { modelSpec: pinned });

			assert.ok(mock.calls.length >= 1, "the LLM analyzer ran");
			assert.ok(
				mock.calls.every((c) => c.model === pinned),
				`every LLM call used the pinned model, got: ${mock.calls.map((c) => c.model).join(", ")}`,
			);

			const node = (await classificationNodes(db))[0] as unknown as { model_used: string | null };
			assert.equal(node.model_used, pinned, "the node records the model actually used");
		} finally {
			await close();
		}
	});
});
