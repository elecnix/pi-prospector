import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertProposalRow } from "./helpers.js";
import { acceptProposal, getProposal, getStats, listProposals, rejectProposal } from "../../src/db/queries.js";

describe("proposal queries (v2)", () => {
	it("lists, filters, accepts, and rejects", () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			insertProposalRow(db, { id: "p1", sessionId: "s1", title: "A", severity: "friction" });
			insertProposalRow(db, { id: "p2", sessionId: "s1", title: "B", severity: "waste" });

			assert.equal(listProposals(db).length, 2);
			assert.equal(listProposals(db, "open").length, 2);

			assert.equal(acceptProposal(db, "p1"), true);
			assert.equal(rejectProposal(db, "p2"), true);

			assert.equal(listProposals(db, "applied").length, 1);
			assert.equal(listProposals(db, "rejected").length, 1);
			assert.equal(getProposal(db, "p1")!.status, "applied");
		} finally {
			close();
		}
	});

	it("accept/reject only affect open proposals", () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			insertProposalRow(db, { id: "p1", sessionId: "s1", title: "A", status: "applied" });
			assert.equal(acceptProposal(db, "p1"), false);
			assert.equal(rejectProposal(db, "p1"), false);
			assert.equal(acceptProposal(db, "missing"), false);
		} finally {
			close();
		}
	});

	it("getStats reports v2 status counts and analysis stats", () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			insertProposalRow(db, { id: "pa", sessionId: "s1", title: "a" });
			insertProposalRow(db, { id: "pb", sessionId: "s1", title: "b", status: "applied" });
			insertProposalRow(db, { id: "pc", sessionId: "s1", title: "c", status: "duplicate" });

			const stats = getStats(db);
			assert.equal(stats.proposalsByStatus.open, 1);
			assert.equal(stats.proposalsByStatus.applied, 1);
			assert.equal(stats.proposalsByStatus.duplicate, 1);
			assert.equal(stats.proposalsByStatus.rejected, 0);
			assert.equal(stats.totalSessions, 1);
			assert.equal(stats.analysis.nodes, 0);
			assert.deepEqual(stats.analysis.nodesByKind, {});
		} finally {
			close();
		}
	});
});
