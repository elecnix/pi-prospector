import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertProposalRow } from "./helpers.js";
import {
	acceptProposal,
	getProposal,
	getStats,
	listProposals,
	rejectProposal,
	getLatestDecision,
	getDecisionsForProposal,
	getAllDecisions,
	acceptProposalsWithRemediation,
	getRemediation,
	getDecisionsForRemediation,
} from "../../src/db/queries.js";

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

	it("filters by severity, and by status and severity together", () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			insertProposalRow(db, { id: "p1", sessionId: "s1", title: "A", severity: "friction" });
			insertProposalRow(db, { id: "p2", sessionId: "s1", title: "B", severity: "waste" });
			insertProposalRow(db, { id: "p3", sessionId: "s1", title: "C", severity: "friction" });

			assert.equal(listProposals(db, undefined, "friction").length, 2);
			assert.equal(listProposals(db, undefined, "waste").length, 1);
			assert.equal(listProposals(db, undefined, "reinforcement").length, 0);

			assert.equal(rejectProposal(db, "p3"), true);
			// status + severity are ANDed together.
			assert.equal(listProposals(db, "open", "friction").length, 1);
			assert.equal(listProposals(db, "rejected", "friction").length, 1);
			assert.equal(listProposals(db, "open", "waste").length, 1);
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

describe("proposal decisions (append-only human feedback)", () => {
	it("records a decision keyed by input_key when accepting/rejecting", () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			insertProposalRow(db, { id: "p1", sessionId: "s1", title: "A", inputKey: "ik-1" });
			insertProposalRow(db, { id: "p2", sessionId: "s1", title: "B", inputKey: "ik-2" });

			assert.equal(acceptProposal(db, "p1", { disposition: "done", rationale: "already did it", actual_change: "commit abc123" }), true);
			assert.equal(rejectProposal(db, "p2", { rationale: "current harness already covers this" }), true);

			const d1 = getLatestDecision(db, "ik-1")!;
			assert.equal(d1.decision, "accepted");
			assert.equal(d1.disposition, "done");
			assert.equal(d1.rationale, "already did it");
			assert.equal(d1.actual_change, "commit abc123");

			const d2 = getLatestDecision(db, "ik-2")!;
			assert.equal(d2.decision, "rejected");
			assert.equal(d2.rationale, "current harness already covers this");
			assert.equal(getAllDecisions(db).length, 2);
		} finally {
			close();
		}
	});

	it("maps done_differently disposition to accepted_modified", () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			insertProposalRow(db, { id: "p1", sessionId: "s1", title: "A", inputKey: "ik-1" });
			assert.equal(acceptProposal(db, "p1", { disposition: "done_differently", rationale: "capped iterations instead of banning loops" }), true);
			const d = getLatestDecision(db, "ik-1")!;
			assert.equal(d.decision, "accepted_modified");
			assert.equal(d.disposition, "done_differently");
			assert.equal(getProposal(db, "p1")!.status, "applied");
		} finally {
			close();
		}
	});

	it("records no decision when the proposal is not open, and id-only accept still works", () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			insertProposalRow(db, { id: "p1", sessionId: "s1", title: "A", status: "applied", inputKey: "ik-1" });
			assert.equal(acceptProposal(db, "p1", { rationale: "too late" }), false);
			assert.equal(getDecisionsForProposal(db, "ik-1").length, 0);

			insertProposalRow(db, { id: "p2", sessionId: "s1", title: "B", inputKey: "ik-2" });
			assert.equal(acceptProposal(db, "p2"), true); // backward-compatible id-only call
			assert.equal(getDecisionsForProposal(db, "ik-2").length, 1);
		} finally {
			close();
		}
	});
});

describe("remediations (one action addressing many proposals)", () => {
	it("accepts many proposals linked to a single shared remediation", () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			insertProposalRow(db, { id: "p1", sessionId: "s1", title: "A", inputKey: "ik-1" });
			insertProposalRow(db, { id: "p2", sessionId: "s1", title: "B", inputKey: "ik-2" });
			insertProposalRow(db, { id: "p3", sessionId: "s1", title: "C", inputKey: "ik-3" });

			const res = acceptProposalsWithRemediation(
				db,
				["p1", "p2", "p3"],
				{ description: "consolidated polling guidance into AGENTS.md", actual_change: "commit abc123" },
				{ disposition: "done" },
			);
			assert.deepEqual(res.accepted, ["p1", "p2", "p3"]);
			assert.deepEqual(res.skipped, []);
			assert.ok(res.remediationId);

			const rem = getRemediation(db, res.remediationId!)!;
			assert.equal(rem.description, "consolidated polling guidance into AGENTS.md");
			assert.equal(rem.actual_change, "commit abc123");

			for (const [id, ik] of [["p1", "ik-1"], ["p2", "ik-2"], ["p3", "ik-3"]] as const) {
				assert.equal(getProposal(db, id)!.status, "applied");
				const d = getLatestDecision(db, ik)!;
				assert.equal(d.decision, "accepted");
				assert.equal(d.disposition, "done");
				assert.equal(d.remediation_id, res.remediationId);
				// The description doubles as the rationale so each decision row stays
				// self-contained for the meta-analyzer corpus.
				assert.equal(d.rationale, "consolidated polling guidance into AGENTS.md");
			}
			assert.equal(getDecisionsForRemediation(db, res.remediationId!).length, 3);
		} finally {
			close();
		}
	});

	it("skips non-open and missing proposals, reporting them", () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			insertProposalRow(db, { id: "p1", sessionId: "s1", title: "A", inputKey: "ik-1" });
			insertProposalRow(db, { id: "p2", sessionId: "s1", title: "B", status: "applied", inputKey: "ik-2" });

			const res = acceptProposalsWithRemediation(db, ["p1", "p2", "missing"], { description: "one fix" });
			assert.deepEqual(res.accepted, ["p1"]);
			assert.deepEqual(res.skipped, ["p2", "missing"]);
			assert.ok(res.remediationId);
			assert.equal(getDecisionsForRemediation(db, res.remediationId!).length, 1);
		} finally {
			close();
		}
	});

	it("creates no remediation row when nothing is accepted", () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			insertProposalRow(db, { id: "p1", sessionId: "s1", title: "A", status: "rejected", inputKey: "ik-1" });

			const res = acceptProposalsWithRemediation(db, ["p1", "missing"], { description: "one fix" });
			assert.equal(res.remediationId, null);
			assert.deepEqual(res.accepted, []);
			assert.deepEqual(res.skipped, ["p1", "missing"]);
			const count = (db.prepare("SELECT COUNT(*) AS c FROM remediations").get() as { c: number }).c;
			assert.equal(count, 0);
		} finally {
			close();
		}
	});

	it("an explicit rationale overrides the description default; done_differently maps to accepted_modified", () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			insertProposalRow(db, { id: "p1", sessionId: "s1", title: "A", inputKey: "ik-1" });

			const res = acceptProposalsWithRemediation(
				db,
				["p1"],
				{ description: "capped iterations" },
				{ disposition: "done_differently", rationale: "custom why" },
			);
			assert.ok(res.remediationId);
			const d = getLatestDecision(db, "ik-1")!;
			assert.equal(d.decision, "accepted_modified");
			assert.equal(d.rationale, "custom why");
		} finally {
			close();
		}
	});
});
