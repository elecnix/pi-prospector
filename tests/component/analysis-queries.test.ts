import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";
import {
	createRun,
	finishRun,
	getRun,
	getEdgesFrom,
	getEdgesTo,
	getAnchoredMessageIds,
	getMessage,
	getNodesByAnalyzer,
	insertEdge,
	insertNode,
	resolveConfig,
	upsertAnalyzerDef,
} from "../../src/db/analysis-queries.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createThrowingLLM } from "../../src/analyze/mock-llm.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { EDGE_KINDS, REF_KINDS } from "../../src/analyze/edge-kinds.js";

async function seedNode(db: AsyncDatabase, id: string, sessionId = "s1"): Promise<void> {
	await insertNode(db, {
		id,
		sessionId,
		analyzerId: "a",
		analyzerVersionId: "1",
		configId: "c",
		runId: null,
		nodeKind: "metric",
		contentJson: "{}",
		sourceSetHash: "ssh",
		inputKey: `ih-${id}`,
		outputKey: `ok-${id}`,
		createdAt: new Date().toISOString(),
	});
}

describe("analysis runs", () => {
	it("creates, finishes, and reads a run", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await createRun(db, {
				id: "run1",
				analyzerId: "a",
				analyzerVersionId: "1",
				configId: "c",
				sessionId: "s1",
				mode: "fill",
				promptBundleHash: "pb",
				modelSpec: "anthropic/x",
			});
			await finishRun(db, "run1", { status: "ok", nodesProduced: 3, nodesSkipped: 1, costUsd: 0.5, tokensUsed: 100 });
			const run = (await getRun(db, "run1"))!;
			assert.equal(run.status, "ok");
			assert.equal(run.nodes_produced, 3);
			assert.equal(run.model_spec, "anthropic/x");
			assert.ok(run.finished_at);
			assert.equal(await getRun(db, "missing"), undefined);
		} finally {
			await close();
		}
	});
});

describe("config resolution (content-addressed)", () => {
	it("returns the same id for identical configs and a new id for changes", async () => {
		const { db, close } = await tempDb();
		try {
			await upsertAnalyzerDef(db, { id: "a", label: "A", description: "", anchorSpan: "pair", dependencies: [] });
			const c1 = await resolveConfig(db, { analyzerId: "a", configJson: { x: 1 }, label: "default" });
			const c2 = await resolveConfig(db, { analyzerId: "a", configJson: { x: 1 }, label: "default" });
			assert.equal(c1.id, c2.id);
			const c3 = await resolveConfig(db, { analyzerId: "a", configJson: { x: 2 } });
			assert.notEqual(c1.id, c3.id);
		} finally {
			await close();
		}
	});
});

describe("edges and anchored messages", () => {
	it("queries edges by source and target", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await seedNode(db, "n1");
			await insertEdge(db, { fromNodeId: "n1", toRefKind: REF_KINDS.SESSION, toRefId: "s1", edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 });
			await insertEdge(db, { fromNodeId: "n1", toRefKind: REF_KINDS.ANALYSIS_NODE, toRefId: "x", edgeKind: EDGE_KINDS.CONSUMES, ordinal: 1 });

			assert.equal((await getEdgesFrom(db, "n1")).length, 2);
			assert.equal((await getEdgesTo(db, "s1")).length, 1);
			assert.equal((await getEdgesTo(db, "s1", EDGE_KINDS.ANCHORS)).length, 1);
			assert.equal((await getEdgesTo(db, "s1", EDGE_KINDS.CONSUMES)).length, 0);
		} finally {
			await close();
		}
	});

	it("resolves anchored message ids and rows", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			const [m1] = await insertMessages(db, "s1", [{ role: "user", text: "hi" }]);
			await seedNode(db, "n1");
			await insertEdge(db, { fromNodeId: "n1", toRefKind: REF_KINDS.MESSAGE, toRefId: m1!, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 });
			assert.deepEqual(await getAnchoredMessageIds(db, "n1"), [m1]);
			assert.equal((await getMessage(db, m1!))!.content_text, "hi");
			assert.equal(await getMessage(db, "nope"), undefined);
		} finally {
			await close();
		}
	});

	it("message loaders carry model and cost_usd when recorded", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			const ids = await insertMessages(db, "s1", [
				{ role: "user", text: "do it" },
				{ role: "assistant", text: "done", model: "claude-3-5-sonnet", costUsd: 0.042 },
			]);

			// The recorded cost/model survives the loader verbatim.
			const priced = (await getMessage(db, ids[1]!))!;
			assert.equal(priced.content_text, "done");
			assert.equal(priced.model, "claude-3-5-sonnet");
			assert.equal(priced.cost_usd, 0.042);

			// An unrecorded message keeps both null — money is never invented as 0.
			const unpriced = (await getMessage(db, ids[0]!))!;
			assert.equal(unpriced.model, null);
			assert.equal(unpriced.cost_usd, null);
		} finally {
			await close();
		}
	});

	it("framework.getAnchoredMessages returns the pair's user message", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [
				{ role: "user", text: "do a thing" },
				{ role: "assistant", text: "done" },
			]);
			const fw = new AnalyzerFramework({ db, llm: createThrowingLLM(), modelTiers: DEFAULT_MODEL_TIERS });
			await fw.register(turnPairCoreAnalyzer);
			await fw.run("s1", {});

			const node = (await getNodesByAnalyzer(db, "turn-pair-core", "s1"))[0]!;
			const anchored = await fw.getAnchoredMessages(node.id);
			assert.equal(anchored.length, 1);
			assert.equal(anchored[0]!.content_text, "do a thing");
		} finally {
			await close();
		}
	});
});
