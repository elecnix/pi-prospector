import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
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

function seedNode(db: import("better-sqlite3").Database, id: string, sessionId = "s1"): void {
	insertNode(db, {
		id,
		sessionId,
		analyzerId: "a",
		analyzerVersionId: "1",
		configId: "c",
		runId: null,
		nodeKind: "metric",
		contentJson: "{}",
		sourceSetHash: "ssh",
		inputHash: `ih-${id}`,
		createdAt: new Date().toISOString(),
	});
}

describe("analysis runs", () => {
	it("creates, finishes, and reads a run", () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			createRun(db, {
				id: "run1",
				analyzerId: "a",
				analyzerVersionId: "1",
				configId: "c",
				sessionId: "s1",
				mode: "fill",
				promptBundleHash: "pb",
				modelSpec: "anthropic/x",
			});
			finishRun(db, "run1", { status: "ok", nodesProduced: 3, nodesSkipped: 1, costUsd: 0.5, tokensUsed: 100 });
			const run = getRun(db, "run1");
			assert.equal(run!.status, "ok");
			assert.equal(run!.nodes_produced, 3);
			assert.equal(run!.model_spec, "anthropic/x");
			assert.ok(run!.finished_at);
			assert.equal(getRun(db, "missing"), undefined);
		} finally {
			close();
		}
	});
});

describe("config resolution (content-addressed)", () => {
	it("returns the same id for identical configs and a new id for changes", () => {
		const { db, close } = tempDb();
		try {
			upsertAnalyzerDef(db, { id: "a", label: "A", description: "", anchorSpan: "pair", dependencies: [] });
			const c1 = resolveConfig(db, { analyzerId: "a", configJson: { x: 1 }, label: "default" });
			const c2 = resolveConfig(db, { analyzerId: "a", configJson: { x: 1 }, label: "default" });
			assert.equal(c1.id, c2.id);
			const c3 = resolveConfig(db, { analyzerId: "a", configJson: { x: 2 } });
			assert.notEqual(c1.id, c3.id);
		} finally {
			close();
		}
	});
});

describe("edges and anchored messages", () => {
	it("queries edges by source and target", () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			seedNode(db, "n1");
			insertEdge(db, { fromNodeId: "n1", toRefKind: REF_KINDS.SESSION, toRefId: "s1", edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 });
			insertEdge(db, { fromNodeId: "n1", toRefKind: REF_KINDS.ANALYSIS_NODE, toRefId: "x", edgeKind: EDGE_KINDS.CONSUMES, ordinal: 1 });

			assert.equal(getEdgesFrom(db, "n1").length, 2);
			assert.equal(getEdgesTo(db, "s1").length, 1);
			assert.equal(getEdgesTo(db, "s1", EDGE_KINDS.ANCHORS).length, 1);
			assert.equal(getEdgesTo(db, "s1", EDGE_KINDS.CONSUMES).length, 0);
		} finally {
			close();
		}
	});

	it("resolves anchored message ids and rows", () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			const [m1] = insertMessages(db, "s1", [{ role: "user", text: "hi" }]);
			seedNode(db, "n1");
			insertEdge(db, { fromNodeId: "n1", toRefKind: REF_KINDS.MESSAGE, toRefId: m1!, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 });
			assert.deepEqual(getAnchoredMessageIds(db, "n1"), [m1]);
			assert.equal(getMessage(db, m1!)!.content_text, "hi");
			assert.equal(getMessage(db, "nope"), undefined);
		} finally {
			close();
		}
	});

	it("framework.getAnchoredMessages returns the pair's user message", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			insertMessages(db, "s1", [
				{ role: "user", text: "do a thing" },
				{ role: "assistant", text: "done" },
			]);
			const fw = new AnalyzerFramework({ db, llm: createThrowingLLM(), modelTiers: DEFAULT_MODEL_TIERS });
			fw.register(turnPairCoreAnalyzer);
			await fw.run("s1", {});

			const node = getNodesByAnalyzer(db, "turn-pair-core", "s1")[0]!;
			const anchored = fw.getAnchoredMessages(node.id);
			assert.equal(anchored.length, 1);
			assert.equal(anchored[0]!.content_text, "do a thing");
		} finally {
			close();
		}
	});
});
