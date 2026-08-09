import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { insertNode, insertEdge } from "../../src/db/analysis-queries.js";
import { computeDeletionSet, applyDeletionSet } from "../../src/db/gc.js";
import { checkGraphIntegrity } from "../../src/db/graph-integrity.js";
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

	// B consumes A's nA1 (the dangling-trail category gc must clean up).
	insertEdge(db, { fromNodeId: "nB1", toRefKind: REF_KINDS.ANALYSIS_NODE, toRefId: "okA1", edgeKind: EDGE_KINDS.CONSUMES, ordinal: 0 });
	// A produces a proposal and anchors to a message.
	insertEdge(db, { fromNodeId: "nA1", toRefKind: REF_KINDS.PROPOSAL, toRefId: "p1", edgeKind: EDGE_KINDS.PRODUCES, ordinal: 1 });
	insertEdge(db, { fromNodeId: "nA1", toRefKind: REF_KINDS.MESSAGE, toRefId: m1!, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 2 });
	// B's own anchor stays.
	insertEdge(db, { fromNodeId: "nB1", toRefKind: REF_KINDS.SESSION, toRefId: "s1", edgeKind: EDGE_KINDS.ANCHORS, ordinal: 1 });

	// Proposal p1 materialised from nA1, with a human decision (never gc'd).
	db.prepare(
		"INSERT INTO proposals (id, created_at, updated_at, session_id, source_node_id, analyzer_id, target_type, target_path, title, severity, summary, detail, evidence, confidence, status, input_key) " +
			"VALUES ('p1', ?, ?, 's1', 'nA1', 'analyzer-A', 'config', NULL, 'Prop A', 'friction', 'summary', NULL, NULL, 0.5, 'applied', 'ik-p1')",
	).run(new Date().toISOString(), new Date().toISOString());
	db.prepare("INSERT INTO proposal_decisions (id, proposal_input_key, decision, disposition, decided_at) VALUES ('d1', 'ik-p1', 'accepted', 'done', ?)").run(new Date().toISOString());
}

describe("prospect gc (#51)", () => {
	it("removes an analyzer's nodes, both edge directions, and its proposals — but never decisions", () => {
		const { db, close } = tempDb();
		try {
			buildGraph(db);
			const catalog = computeDeletionSet(db, { kind: "analyzer", analyzerId: "analyzer-A" });
			assert.equal(catalog.nodes.length, 2);
			// edges from A nodes (produces, anchors) + edges pointing at A output_keys (B's consumes)
			assert.equal(catalog.edgeIds.length, 3);
			assert.equal(catalog.proposalIds.length, 1);

			applyDeletionSet(db, catalog);

			// A's nodes gone, B's node remains.
			assert.equal(db.prepare("SELECT COUNT(*) AS c FROM analysis_nodes WHERE analyzer_id = 'analyzer-A'").get()!.c, 0);
			assert.equal(db.prepare("SELECT COUNT(*) AS c FROM analysis_nodes WHERE id = 'nB1'").get()!.c, 1);
			// The consumes edge pointing at removed A is gone; B's anchor remains.
			assert.equal(db.prepare("SELECT COUNT(*) AS c FROM analysis_edges WHERE from_node_id = 'nB1' AND edge_kind = 'consumes'").get()!.c, 0);
			assert.equal(db.prepare("SELECT COUNT(*) AS c FROM analysis_edges WHERE from_node_id = 'nB1' AND edge_kind = 'anchors'").get()!.c, 1);
			// Proposal gone, but the human decision survives.
			assert.equal(db.prepare("SELECT COUNT(*) AS c FROM proposals WHERE id = 'p1'").get()!.c, 0);
			assert.equal(db.prepare("SELECT COUNT(*) AS c FROM proposal_decisions WHERE id = 'd1'").get()!.c, 1);

			// The graph is referentially intact after gc (verify's guard is clean).
			const integrity = checkGraphIntegrity(db);
			assert.equal(integrity.all.length, 0);
		} finally {
			close();
		}
	});

	it("removes only one run's nodes for --run", () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s2");
			seedNode(db, "r1-node", "analyzer-A", "okA", "run-one", "s2");
			insertSession(db, "s3");
			seedNode(db, "r2-node", "analyzer-A", "okA2", "run-two", "s3");

			const catalog = computeDeletionSet(db, { kind: "run", runId: "run-one" });
			assert.equal(catalog.nodes.length, 1);
			assert.equal(catalog.nodes[0]!.id, "r1-node");
			assert.equal(catalog.runIdsToDelete.length, 1);

			applyDeletionSet(db, catalog);
			assert.equal(db.prepare("SELECT COUNT(*) AS c FROM analysis_nodes").get()!.c, 1);
			assert.equal(db.prepare("SELECT COUNT(*) AS c FROM analysis_runs WHERE id = 'run-one'").get()!.c, 0);
		} finally {
			close();
		}
	});

	it("dry-run reports the set without changing anything", () => {
		const { db, close } = tempDb();
		try {
			buildGraph(db);
			const before = db.prepare("SELECT COUNT(*) AS c FROM analysis_nodes").get()!.c;
			const catalog = computeDeletionSet(db, { kind: "analyzer", analyzerId: "analyzer-A" });
			// Dry-run = compute only; nothing applied.
			assert.equal(db.prepare("SELECT COUNT(*) AS c FROM analysis_nodes").get()!.c, before);
			assert.ok(catalog.nodes.length > 0);
		} finally {
			close();
		}
	});
});
