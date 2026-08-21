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
	it("lists, filters, accepts, and rejects", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertProposalRow(db, { id: "p1", sessionId: "s1", title: "A", severity: "friction" });
			await insertProposalRow(db, { id: "p2", sessionId: "s1", title: "B", severity: "waste" });

			assert.equal((await listProposals(db)).length, 2);
			assert.equal((await listProposals(db, "open")).length, 2);

			assert.equal(await acceptProposal(db, "p1"), true);
			assert.equal(await rejectProposal(db, "p2"), true);

			assert.equal((await listProposals(db, "applied")).length, 1);
			assert.equal((await listProposals(db, "rejected")).length, 1);
			assert.equal((await getProposal(db, "p1"))!.status, "applied");
		} finally {
			await close();
		}
	});

	it("filters by the session's harness source", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s-pi", "/tmp/pi.jsonl", "", "pi");
			await insertSession(db, "s-claude", "/tmp/claude.jsonl", "", "claude");
			await insertProposalRow(db, { id: "pa", sessionId: "s-pi", title: "From Pi" });
			await insertProposalRow(db, { id: "pb", sessionId: "s-claude", title: "From Claude" });

			const all = (await listProposals(db, undefined, undefined, undefined, undefined, undefined)).map((p) => p.title);
			assert.deepEqual(all.sort(), ["From Claude", "From Pi"]);

			const pi = (await listProposals(db, undefined, undefined, undefined, undefined, "pi")).map((p) => p.title);
			assert.deepEqual(pi, ["From Pi"]);
		} finally {
			await close();
		}
	});

	it("filters by severity, and by status and severity together", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertProposalRow(db, { id: "p1", sessionId: "s1", title: "A", severity: "friction" });
			await insertProposalRow(db, { id: "p2", sessionId: "s1", title: "B", severity: "waste" });
			await insertProposalRow(db, { id: "p3", sessionId: "s1", title: "C", severity: "friction" });

			assert.equal((await listProposals(db, undefined, "friction")).length, 2);
			assert.equal((await listProposals(db, undefined, "waste")).length, 1);
			assert.equal((await listProposals(db, undefined, "reinforcement")).length, 0);

			assert.equal(await rejectProposal(db, "p3"), true);
			// status + severity are ANDed together.
			assert.equal((await listProposals(db, "open", "friction")).length, 1);
			assert.equal((await listProposals(db, "rejected", "friction")).length, 1);
			assert.equal((await listProposals(db, "open", "waste")).length, 1);
		} finally {
			await close();
		}
	});

	it("accept/reject only affect open proposals", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertProposalRow(db, { id: "p1", sessionId: "s1", title: "A", status: "applied" });
			assert.equal(await acceptProposal(db, "p1"), false);
			assert.equal(await rejectProposal(db, "p1"), false);
			assert.equal(await acceptProposal(db, "missing"), false);
		} finally {
			await close();
		}
	});

	it("getStats reports v2 status counts and analysis stats", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertProposalRow(db, { id: "pa", sessionId: "s1", title: "a" });
			await insertProposalRow(db, { id: "pb", sessionId: "s1", title: "b", status: "applied" });
			await insertProposalRow(db, { id: "pc", sessionId: "s1", title: "c", status: "duplicate" });

			const stats = await getStats(db);
			assert.equal(stats.proposalsByStatus.open, 1);
			assert.equal(stats.proposalsByStatus.applied, 1);
			assert.equal(stats.proposalsByStatus.duplicate, 1);
			assert.equal(stats.proposalsByStatus.rejected, 0);
			assert.equal(stats.totalSessions, 1);
			assert.equal(stats.analysis.nodes, 0);
			assert.deepEqual(stats.analysis.nodesByKind, {});
		} finally {
			await close();
		}
	});
});

describe("proposal decisions (append-only human feedback)", () => {
	it("records a decision keyed by input_key when accepting/rejecting", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertProposalRow(db, { id: "p1", sessionId: "s1", title: "A", inputKey: "ik-1" });
			await insertProposalRow(db, { id: "p2", sessionId: "s1", title: "B", inputKey: "ik-2" });

			assert.equal(await acceptProposal(db, "p1", { disposition: "done", rationale: "already did it", actual_change: "commit abc123" }), true);
			assert.equal(await rejectProposal(db, "p2", { rationale: "current harness already covers this" }), true);

			const d1 = (await getLatestDecision(db, "ik-1"))!;
			assert.equal(d1.decision, "accepted");
			assert.equal(d1.disposition, "done");
			assert.equal(d1.rationale, "already did it");
			assert.equal(d1.actual_change, "commit abc123");

			const d2 = (await getLatestDecision(db, "ik-2"))!;
			assert.equal(d2.decision, "rejected");
			assert.equal(d2.rationale, "current harness already covers this");
			assert.equal((await getAllDecisions(db)).length, 2);
		} finally {
			await close();
		}
	});

	it("maps done_differently disposition to accepted_modified", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertProposalRow(db, { id: "p1", sessionId: "s1", title: "A", inputKey: "ik-1" });
			assert.equal(await acceptProposal(db, "p1", { disposition: "done_differently", rationale: "capped iterations instead of banning loops" }), true);
			const d = (await getLatestDecision(db, "ik-1"))!;
			assert.equal(d.decision, "accepted_modified");
			assert.equal(d.disposition, "done_differently");
			assert.equal((await getProposal(db, "p1"))!.status, "applied");
		} finally {
			await close();
		}
	});

	it("records no decision when the proposal is not open, and id-only accept still works", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertProposalRow(db, { id: "p1", sessionId: "s1", title: "A", status: "applied", inputKey: "ik-1" });
			assert.equal(await acceptProposal(db, "p1", { rationale: "too late" }), false);
			assert.equal((await getDecisionsForProposal(db, "ik-1")).length, 0);

			await insertProposalRow(db, { id: "p2", sessionId: "s1", title: "B", inputKey: "ik-2" });
			assert.equal(await acceptProposal(db, "p2"), true); // backward-compatible id-only call
			assert.equal((await getDecisionsForProposal(db, "ik-2")).length, 1);
		} finally {
			await close();
		}
	});
});

describe("remediations (one action addressing many proposals)", () => {
	it("accepts many proposals linked to a single shared remediation", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertProposalRow(db, { id: "p1", sessionId: "s1", title: "A", inputKey: "ik-1" });
			await insertProposalRow(db, { id: "p2", sessionId: "s1", title: "B", inputKey: "ik-2" });
			await insertProposalRow(db, { id: "p3", sessionId: "s1", title: "C", inputKey: "ik-3" });

			const res = await acceptProposalsWithRemediation(
				db,
				["p1", "p2", "p3"],
				{ description: "consolidated polling guidance into AGENTS.md", actual_change: "commit abc123" },
				{ disposition: "done" },
			);
			assert.deepEqual(res.accepted, ["p1", "p2", "p3"]);
			assert.deepEqual(res.skipped, []);
			assert.ok(res.remediationId);

			const rem = (await getRemediation(db, res.remediationId!))!;
			assert.equal(rem.description, "consolidated polling guidance into AGENTS.md");
			assert.equal(rem.actual_change, "commit abc123");

			for (const [id, ik] of [["p1", "ik-1"], ["p2", "ik-2"], ["p3", "ik-3"]] as const) {
				assert.equal((await getProposal(db, id))!.status, "applied");
				const d = (await getLatestDecision(db, ik))!;
				assert.equal(d.decision, "accepted");
				assert.equal(d.disposition, "done");
				assert.equal(d.remediation_id, res.remediationId);
				// The description doubles as the rationale so each decision row stays
				// self-contained for the meta-analyzer corpus.
				assert.equal(d.rationale, "consolidated polling guidance into AGENTS.md");
			}
			assert.equal((await getDecisionsForRemediation(db, res.remediationId!)).length, 3);
		} finally {
			await close();
		}
	});

	it("skips non-open and missing proposals, reporting them", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertProposalRow(db, { id: "p1", sessionId: "s1", title: "A", inputKey: "ik-1" });
			await insertProposalRow(db, { id: "p2", sessionId: "s1", title: "B", status: "applied", inputKey: "ik-2" });

			const res = await acceptProposalsWithRemediation(db, ["p1", "p2", "missing"], { description: "one fix" });
			assert.deepEqual(res.accepted, ["p1"]);
			assert.deepEqual(res.skipped, ["p2", "missing"]);
			assert.ok(res.remediationId);
			assert.equal((await getDecisionsForRemediation(db, res.remediationId!)).length, 1);
		} finally {
			await close();
		}
	});

	it("creates no remediation row when nothing is accepted", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertProposalRow(db, { id: "p1", sessionId: "s1", title: "A", status: "rejected", inputKey: "ik-1" });

			const res = await acceptProposalsWithRemediation(db, ["p1", "missing"], { description: "one fix" });
			assert.equal(res.remediationId, null);
			assert.deepEqual(res.accepted, []);
			assert.deepEqual(res.skipped, ["p1", "missing"]);
			const count = ((await db.prepare("SELECT COUNT(*) AS c FROM remediations").get()) as { c: number }).c;
			assert.equal(count, 0);
		} finally {
			await close();
		}
	});

	it("an explicit rationale overrides the description default; done_differently maps to accepted_modified", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertProposalRow(db, { id: "p1", sessionId: "s1", title: "A", inputKey: "ik-1" });

			const res = await acceptProposalsWithRemediation(
				db,
				["p1"],
				{ description: "capped iterations" },
				{ disposition: "done_differently", rationale: "custom why" },
			);
			assert.ok(res.remediationId);
			const d = (await getLatestDecision(db, "ik-1"))!;
			assert.equal(d.decision, "accepted_modified");
			assert.equal(d.rationale, "custom why");
		} finally {
			await close();
		}
	});
});
