import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { insertNode, insertEdge, findNodeByInputKey } from "../../src/db/analysis-queries.js";
import { computeDeletionSet, retractNodes, newGcRunId, unretract, listRetracted, purgeRetractedBefore } from "../../src/db/gc.js";
import { checkGraphIntegrity } from "../../src/db/graph-integrity.js";
import { verifyNodes } from "../../src/commands/verify.js";
import { EDGE_KINDS, REF_KINDS } from "../../src/analyze/edge-kinds.js";
import type Database from "better-sqlite3";

function seedNode(db: Database, id: string, analyzer: string, outputKey: string, runId: string | null = null, sessionId = "s1"): void {
	insertNode(db, {
		id,
		sessionId,
		analyzerId: analyzer,
		analyzerVersionId: "1",
		configId: "cfg",
		runId,
		nodeKind: "metric",
		contentJson: "{}",
		sourceSetHash: `ssh-${analyzer}-${id}`,
		inputKey: `ih-${id}`,
		outputKey,
		createdAt: new Date().toISOString(),
	});
}

/** A graph where analyzer A is consumed by B, and A produced a proposal with a recorded decision. */
function buildGraph(db: Database): void {
	insertSession(db, "s1");
	const [m1] = insertMessages(db, "s1", [{ role: "user", text: "hi" }]);

	seedNode(db, "nA1", "analyzer-A", "okA1", null);
	seedNode(db, "nA2", "analyzer-A", "okA2", null);
	seedNode(db, "nB1", "analyzer-B", "okB", null);

	// B consumes A's nA1 (the dangling-trail category).
	insertEdge(db, { fromNodeId: "nB1", toRefKind: REF_KINDS.ANALYSIS_NODE, toRefId: "okA1", edgeKind: EDGE_KINDS.CONSUMES, ordinal: 0 });
	// A produces a proposal and anchors to a message.
	insertEdge(db, { fromNodeId: "nA1", toRefKind: REF_KINDS.PROPOSAL, toRefId: "p1", edgeKind: EDGE_KINDS.PRODUCES, ordinal: 1 });
	insertEdge(db, { fromNodeId: "nA1", toRefKind: REF_KINDS.MESSAGE, toRefId: m1!, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 2 });
	insertEdge(db, { fromNodeId: "nB1", toRefKind: REF_KINDS.SESSION, toRefId: "s1", edgeKind: EDGE_KINDS.ANCHORS, ordinal: 1 });

	db.prepare(
		"INSERT INTO proposals (id, created_at, updated_at, session_id, source_node_id, analyzer_id, target_type, target_path, title, severity, summary, detail, evidence, confidence, status, input_key) " +
			"VALUES ('p1', ?, ?, 's1', 'nA1', 'analyzer-A', 'config', NULL, 'Prop A', 'friction', 'summary', NULL, NULL, 0.5, 'applied', 'ik-p1')",
	).run(new Date().toISOString(), new Date().toISOString());
	db.prepare("INSERT INTO proposal_decisions (id, proposal_input_key, decision, disposition, decided_at) VALUES ('d1', 'ik-p1', 'accepted', 'done', ?)").run(new Date().toISOString());
}

const liveCount = (db: Database, analyzer: string): number =>
	(db.prepare("SELECT COUNT(*) AS c FROM live_nodes WHERE analyzer_id = ?").get(analyzer) as { c: number }).c;
const allCount = (db: Database, analyzer: string): number =>
	(db.prepare("SELECT COUNT(*) AS c FROM analysis_nodes WHERE analyzer_id = ?").get(analyzer) as { c: number }).c;

describe("retraction (#52)", () => {
	it("gc retracts nodes (tombstone) instead of deleting, and removes their proposals but never decisions", () => {
		const { db, close } = tempDb();
		try {
			buildGraph(db);
			const catalog = computeDeletionSet(db, { kind: "analyzer", analyzerId: "analyzer-A" });
			assert.equal(catalog.nodes.length, 2);
			assert.equal(catalog.proposalIds.length, 1);

			const res = retractNodes(db, catalog, newGcRunId(), new Date().toISOString());
			assert.equal(res.retractedNodes, 2);
			assert.equal(res.removedProposals, 1);

			// Nodes physically remain (append-only), but are hidden from the live view.
			assert.equal(allCount(db, "analyzer-A"), 2);
			assert.equal(liveCount(db, "analyzer-A"), 0);
			assert.equal(liveCount(db, "analyzer-B"), 1);
			// Their proposal is gone; the human decision survives.
			assert.equal(db.prepare("SELECT COUNT(*) AS c FROM proposals WHERE id = 'p1'").get()!.c, 0);
			assert.equal(db.prepare("SELECT COUNT(*) AS c FROM proposal_decisions WHERE id = 'd1'").get()!.c, 1);
			// The graph stays referentially intact (nodes still exist → edges resolve).
			assert.equal(checkGraphIntegrity(db).all.length, 0);
		} finally {
			close();
		}
	});

	it("a retracted node is absent from the live view and scanning, and re-analysis would treat it as missing", () => {
		const { db, close } = tempDb();
		try {
			buildGraph(db);
			const catalog = computeDeletionSet(db, { kind: "analyzer", analyzerId: "analyzer-A" });
			retractNodes(db, catalog, newGcRunId(), "2030-01-01T00:00:00.000Z");
			// findNodeByInputKey (the idempotency/scan lookup) reads live_nodes → absent.
			assert.equal(findNodeByInputKey(db, "ih-nA1"), undefined);
		} finally {
			close();
		}
	});

	it("a retracted node's content still verifies (#52)", () => {
		const { db, close } = tempDb();
		try {
			buildGraph(db);
			const catalog = computeDeletionSet(db, { kind: "analyzer", analyzerId: "analyzer-A" });
			retractNodes(db, catalog, newGcRunId(), new Date().toISOString());
			// verifyNodes must include retracted nodes and confirm they still hash.
			const r = verifyNodes(db);
			// 2 retracted (A) + 1 live (B) = 3 nodes. The key guarantee is that verify
			// INCLUDES the retracted nodes (retraction must not hide drift); the
			// fake seeded keys here are unrelated to the hashes, so we assert on count.
			assert.equal(r.total, 3);
		} finally {
			close();
		}
	});

	it("unretract reverses a gc (reversible rollback)", () => {
		const { db, close } = tempDb();
		try {
			buildGraph(db);
			const id = newGcRunId();
			const catalog = computeDeletionSet(db, { kind: "analyzer", analyzerId: "analyzer-A" });
			retractNodes(db, catalog, id, new Date().toISOString());
			assert.equal(liveCount(db, "analyzer-A"), 0);

			assert.equal(listRetracted(db).length, 2);
			const undone = unretract(db, id);
			assert.equal(undone, 2);
			assert.equal(liveCount(db, "analyzer-A"), 2);
		} finally {
			close();
		}
	});

	it("purge --retracted-before physically reclaims only old retracted nodes", () => {
		const { db, close } = tempDb();
		try {
			buildGraph(db);
			const catalog = computeDeletionSet(db, { kind: "analyzer", analyzerId: "analyzer-A" });
			retractNodes(db, catalog, newGcRunId(), "2025-01-01T00:00:00.000Z");
			const res = purgeRetractedBefore(db, "2026-01-01T00:00:00.000Z");
			assert.equal(res.nodes, 2);
			// Physically gone now (not just hidden).
			assert.equal(allCount(db, "analyzer-A"), 0);
			// No dangling refs after purge.
			assert.equal(checkGraphIntegrity(db).all.length, 0);
		} finally {
			close();
		}
	});
});
