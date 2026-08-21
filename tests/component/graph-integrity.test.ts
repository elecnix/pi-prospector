import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { insertNode, insertEdge, resolveConfig, upsertAnalyzerDef } from "../../src/db/analysis-queries.js";
import { checkGraphIntegrity } from "../../src/db/graph-integrity.js";
import { EDGE_KINDS, REF_KINDS } from "../../src/analyze/edge-kinds.js";
import type Database from "better-sqlite3";

function seedNode(db: import("better-sqlite3").Database, id: string, outputKey: string, analyzer = "a", sessionId = "s1"): void {
	insertNode(db, {
		id,
		sessionId,
		analyzerId: analyzer,
		analyzerVersionId: "1",
		configId: "c",
		runId: null,
		nodeKind: "metric",
		contentJson: "{}",
		sourceSetHash: "ssh",
		inputKey: `ih-${id}`,
		outputKey,
		createdAt: new Date().toISOString(),
	});
}

describe("graph integrity (#49)", () => {
	it("reports a clean graph when every target resolves", () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			const [m1] = insertMessages(db, "s1", [{ role: "user", text: "hi" }]);
			seedNode(db, "n1", "out-1", "a", "s1");
			seedNode(db, "n2", "out-2", "b", "s1");

			// consumes → real output_key
			insertEdge(db, { fromNodeId: "n1", toRefKind: REF_KINDS.ANALYSIS_NODE, toRefId: "out-2", edgeKind: EDGE_KINDS.CONSUMES, ordinal: 0 });
			// anchors → real session and message
			insertEdge(db, { fromNodeId: "n1", toRefKind: REF_KINDS.SESSION, toRefId: "s1", edgeKind: EDGE_KINDS.ANCHORS, ordinal: 1 });
			insertEdge(db, { fromNodeId: "n1", toRefKind: REF_KINDS.MESSAGE, toRefId: m1!, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 2 });

			const r = checkGraphIntegrity(db);
			assert.equal(r.checked, 3);
			assert.equal(r.all.length, 0);
		} finally {
await close();
		}
	});

	it("flags a dangling consumes edge whose output_key target is gone (#49 repro)", () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			seedNode(db, "n1", "out-1", "session-overview", "s1");
			// The consumed turn node was deleted out of band — only the edge remains.
			insertEdge(db, { fromNodeId: "n1", toRefKind: REF_KINDS.ANALYSIS_NODE, toRefId: "gone-output-key", edgeKind: EDGE_KINDS.CONSUMES, ordinal: 0 });

			const r = checkGraphIntegrity(db);
			assert.equal(r.checked, 1);
			assert.equal(r.dangling.length, 1);
			assert.equal(r.dangling[0]!.edgeKind, "consumes");
			assert.equal(r.dangling[0]!.toRefKind, "analysis_node");
			assert.equal(r.dangling[0]!.expectedIn, "analysis_nodes.output_key");
			assert.equal(r.dangling[0]!.fromAnalyzerId, "session-overview");
		} finally {
await close();
		}
	});

	it("flags an orphan edge whose source node is missing", () => {
		const { db, close } = await tempDb();
		try {
			// FK is normally ON and would reject a ghost source node at insert —
			// the orphan condition only arises from out-of-band SQL, so emulate it
			// with FK off to prove the check still detects it.
			db.pragma("foreign_keys = OFF");
			await insertSession(db, "s1");
			insertEdge(db, { fromNodeId: "ghost-node", toRefKind: REF_KINDS.SESSION, toRefId: "s1", edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 });

			const r = checkGraphIntegrity(db);
			assert.equal(r.orphanSource.length, 1);
			assert.equal(r.orphanSource[0]!.expectedIn, "analysis_nodes.id");
			assert.equal(r.all.length, 1);
		} finally {
await close();
		}
	});

	it("flags anchors/produces tracing to missing targets by kind", () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			seedNode(db, "n1", "out-1");
			// produces → missing proposal
			insertEdge(db, { fromNodeId: "n1", toRefKind: REF_KINDS.PROPOSAL, toRefId: "ghost-proposal", edgeKind: EDGE_KINDS.PRODUCES, ordinal: 0 });
			// anchors → missing message
			insertEdge(db, { fromNodeId: "n1", toRefKind: REF_KINDS.MESSAGE, toRefId: "ghost-message", edgeKind: EDGE_KINDS.ANCHORS, ordinal: 1 });

			const r = checkGraphIntegrity(db);
			const kinds = r.dangling.map((d) => `${d.edgeKind}->${d.toRefKind}`).sort();
			assert.deepEqual(kinds, ["anchors->message", "produces->proposal"]);
		} finally {
await close();
		}
	});

	it("accepts uses_config edges pointing at a resolved config id", () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			upsertAnalyzerDef(db, { id: "a", label: "A", description: "", anchorSpan: "pair", dependencies: [] });
			const cfg = resolveConfig(db, { analyzerId: "a", configJson: { x: 1 } });
			seedNode(db, "n1", "out-1");
			insertEdge(db, { fromNodeId: "n1", toRefKind: REF_KINDS.CONFIG_VERSION, toRefId: cfg.id, edgeKind: EDGE_KINDS.USES_CONFIG, ordinal: 0 });

			const r = checkGraphIntegrity(db);
			assert.equal(r.all.length, 0);
		} finally {
await close();
		}
	});
});
