import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession } from "./helpers.js";
import { computeProposalInputKey, materializeProposalsFromNode } from "../../src/analyze/proposal-materializer.js";
import { insertNode } from "../../src/db/analysis-queries.js";
import { listProposals } from "../../src/db/queries.js";

function seedNode(db: import("better-sqlite3").Database, id: string): void {
	insertNode(db, {
		id,
		sessionId: "s1",
		analyzerId: "session-overview",
		analyzerVersionId: "1.0.0",
		configId: "c",
		runId: null,
		nodeKind: "summary",
		contentJson: "{}",
		sourceSetHash: "ssh",
		inputKey: `ih-${id}`,
		outputKey: `ok-${id}`,
		createdAt: new Date().toISOString(),
	});
}

describe("computeProposalInputKey", () => {
	it("derives from the source output_key + ordinal, never the LLM text", () => {
		const a = computeProposalInputKey({ sourceOutputKey: "ok-1", ordinal: 0 });
		const b = computeProposalInputKey({ sourceOutputKey: "ok-1", ordinal: 0 });
		assert.equal(a, b, "same source+ordinal is stable regardless of title/path/severity");
	});

	it("differs across ordinal and across source", () => {
		assert.notEqual(
			computeProposalInputKey({ sourceOutputKey: "ok-1", ordinal: 0 }),
			computeProposalInputKey({ sourceOutputKey: "ok-1", ordinal: 1 }),
		);
		assert.notEqual(
			computeProposalInputKey({ sourceOutputKey: "ok-1", ordinal: 0 }),
			computeProposalInputKey({ sourceOutputKey: "ok-2", ordinal: 0 }),
		);
	});
});

describe("materializeProposalsFromNode", () => {
	it("inserts valid proposals and links them with produces edges", () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			seedNode(db, "node1");
			const created = materializeProposalsFromNode(db, {
				sessionId: "s1",
				analyzerId: "session-overview",
				sourceNodeId: "node1",
				sourceOutputKey: "ok-node1",
				now: new Date().toISOString(),
				contentJson: {
					improvement_proposals: [
						{ target_type: "agents_md", target_path: "AGENTS.md", title: "Add tooling note", summary: "s", severity: "friction", confidence: 0.8 },
						{ title: "", summary: "missing title" },
						{ title: "no summary" },
					],
				},
			});
			assert.equal(created, 1);

			const proposals = listProposals(db);
			assert.equal(proposals.length, 1);
			assert.equal(proposals[0]!.target_type, "agents_md");
			assert.equal(proposals[0]!.status, "open");

			const edge = db
				.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ? AND edge_kind = 'produces'")
				.get("node1") as { to_ref_id: string } | undefined;
			assert.ok(edge);
			assert.equal(edge!.to_ref_id, proposals[0]!.id);
		} finally {
			close();
		}
	});

	it("is idempotent for the same source node, but keeps duplicates from distinct sources", () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			seedNode(db, "n1");
			seedNode(db, "n2");
			const payload = {
				improvement_proposals: [{ target_type: "config", title: "Same thing", summary: "s", severity: "friction" }],
			};
			// Same source node, materialised twice → idempotent (keyed on source output_key + ordinal).
			assert.equal(materializeProposalsFromNode(db, { sessionId: "s1", analyzerId: "a", sourceNodeId: "n1", sourceOutputKey: "ok-n1", now: new Date().toISOString(), contentJson: payload }), 1);
			assert.equal(materializeProposalsFromNode(db, { sessionId: "s1", analyzerId: "a", sourceNodeId: "n1", sourceOutputKey: "ok-n1", now: new Date().toISOString(), contentJson: payload }), 0);
			// Distinct source node with byte-identical text → intentionally retained.
			assert.equal(materializeProposalsFromNode(db, { sessionId: "s1", analyzerId: "a", sourceNodeId: "n2", sourceOutputKey: "ok-n2", now: new Date().toISOString(), contentJson: payload }), 1);
			assert.equal(listProposals(db).length, 2);
		} finally {
			close();
		}
	});

	it("returns 0 when there are no proposals", () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			seedNode(db, "n1");
			assert.equal(materializeProposalsFromNode(db, { sessionId: "s1", analyzerId: "a", sourceNodeId: "n1", sourceOutputKey: "ok-n1", now: new Date().toISOString(), contentJson: {} }), 0);
			assert.equal(materializeProposalsFromNode(db, { sessionId: "s1", analyzerId: "a", sourceNodeId: "n1", sourceOutputKey: "ok-n1", now: new Date().toISOString(), contentJson: { improvement_proposals: "not-an-array" } }), 0);
		} finally {
			close();
		}
	});
});
