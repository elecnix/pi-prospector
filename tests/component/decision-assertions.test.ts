/**
 * Issue #73 — fold proposal_decisions and remediations onto the generic
 * assertions relation. This is the riskiest data in the system (it cannot be
 * recomputed), so the migration must be *reversible and verified by content*,
 * not by "it ran".
 *
 * Under test:
 *  1. Backfill: every legacy decision/remediation becomes an assertion, keyed by
 *     content, and `reconcileDecisionsMigration` proves exact parity (counts
 *     reconcile, no missing, no extra).
 *  2. Dual-write: a fresh accept/reject/remediate writes to BOTH the legacy
 *     table (the rollback) and the assertions relation, so the two never
 *     diverge and the migration stays reversible at any moment.
 *  3. Reads go through the assertions relation with identical semantics — the
 *     public decision API (getLatestDecision, getRemediation, …) is unchanged.
 *  4. Durability: decisions are keyed by the proposal's content-addressed
 *     input_key, so a regenerated proposal re-attaches to its decision.
 *  5. The migration is idempotent.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertProposalRow } from "./helpers.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";
import {
	migrateDecisionsToAssertions,
	reconcileDecisionsMigration,
	getProposalAssertionsForKey,
	getRemediationAssertion,
} from "../../src/db/assertions.js";
import {
	acceptProposal,
	rejectProposal,
	acceptProposalsWithRemediation,
	getLatestDecision,
	getDecisionsForProposal,
	getAllDecisions,
	getRemediation,
	getDecisionsForRemediation,
} from "../../src/db/queries.js";
import { migrate } from "../../src/db/schema.js";

/** Insert a legacy decision row directly, as pre-migration data would be. */
async function insertLegacyDecision(
	db: AsyncDatabase,
	d: { ik: string; decision: string; disposition?: string | null; rationale?: string | null; decidedAt?: string; remediationId?: string | null },
): Promise<string> {
	const id = `legacy-${d.ik}-${d.decision}`;
	await db
		.prepare(
			"INSERT INTO proposal_decisions (id, proposal_input_key, decision, disposition, rationale, actual_change, harness_ref, remediation_id, decided_at) " +
				"VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)",
		)
		.run(id, d.ik, d.decision, d.disposition ?? null, d.rationale ?? null, d.remediationId ?? null, d.decidedAt ?? "2026-01-01T00:00:00.000Z");
	return id;
}

/** Insert a legacy remediation row directly. */
async function insertLegacyRemediation(db: AsyncDatabase, id: string, description: string, createdAt = "2026-01-01T00:00:00.000Z"): Promise<void> {
	await db.prepare("INSERT INTO remediations (id, description, actual_change, created_at) VALUES (?, ?, NULL, ?)").run(id, description, createdAt);
}

async function legacyDecisionCount(db: AsyncDatabase): Promise<number> {
	return ((await db.prepare("SELECT COUNT(*) AS c FROM proposal_decisions").get()) as { c: number }).c;
}

describe("decisions/remediations onto assertions (issue #73)", () => {
	it("backfills legacy decisions and remediations and reconciles exactly", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			// Pre-conversion corpus, written straight to the legacy tables.
			await insertLegacyDecision(db, { ik: "ik-1", decision: "accepted", disposition: "done", rationale: "added it", decidedAt: "2026-01-01T00:00:00.000Z" });
			await insertLegacyDecision(db, { ik: "ik-2", decision: "rejected", rationale: "covered", decidedAt: "2026-01-02T00:00:00.000Z" });
			await insertLegacyDecision(db, { ik: "ik-3", decision: "accepted", disposition: "done_differently", decidedAt: "2026-01-03T00:00:00.000Z" });
			await insertLegacyRemediation(db, "rem-1", "consolidated polling guidance", "2026-01-03T00:00:00.000Z");
			await insertLegacyDecision(db, { ik: "ik-4", decision: "accepted", decidedAt: "2026-01-04T00:00:00.000Z", remediationId: "rem-1" });

			const moved = await migrateDecisionsToAssertions(db);
			assert.equal(moved.decisions, 4);
			assert.equal(moved.remediations, 1);

			const r = await reconcileDecisionsMigration(db);
			assert.equal(r.legacyDecisions, r.assertionDecisions);
			assert.equal(r.legacyRemediations, r.assertionRemediations);
			assert.deepEqual(r.missingDecisions, [], "every legacy decision has an assertion");
			assert.deepEqual(r.extraAssertions, [], "no assertion decision without a legacy row");
			assert.deepEqual(r.missingRemediations, [], "every legacy remediation has an assertion");
		} finally {
			await close();
		}
	});

	it("reads backfilled decisions with identical semantics through the public API", async () => {
		const { db, close } = await tempDb();
		try {
			await insertLegacyDecision(db, { ik: "ik-1", decision: "accepted", disposition: "done", rationale: "already did it", decidedAt: "2026-01-01T00:00:00.000Z" });
			await insertLegacyRemediation(db, "rem-1", "consolidated polling guidance");
			await insertLegacyDecision(db, { ik: "ik-2", decision: "accepted", decidedAt: "2026-01-02T00:00:00.000Z", remediationId: "rem-1" });
			await migrateDecisionsToAssertions(db);

			const d1 = (await getLatestDecision(db, "ik-1"))!;
			assert.equal(d1.decision, "accepted");
			assert.equal(d1.disposition, "done");
			assert.equal(d1.rationale, "already did it");
			assert.equal(d1.decided_at, "2026-01-01T00:00:00.000Z");

			const rem = (await getRemediation(db, "rem-1"))!;
			assert.equal(rem.description, "consolidated polling guidance");
			assert.equal((await getDecisionsForRemediation(db, "rem-1")).length, 1, "grouping survives");
			assert.equal((await getAllDecisions(db)).length, 2);
			assert.equal((await getAllDecisions(db)).map((d) => d.remediation_id).filter(Boolean).length, 1);
		} finally {
			await close();
		}
	});

	it("dual-writes fresh decisions to both tables so the migration stays reversible", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertProposalRow(db, { id: "p1", sessionId: "s1", title: "A", inputKey: "ik-1" });

			assert.equal(await acceptProposal(db, "p1", { disposition: "done", rationale: "already did it", actual_change: "abc123" }), true);
			assert.equal(await rejectProposal(db, "p1"), false, "a decided proposal cannot be re-decided");

			// Both the legacy table and the assertions relation hold the decision.
			assert.equal(await legacyDecisionCount(db), 1);
			const d = (await getLatestDecision(db, "ik-1"))!;
			assert.equal(d.decision, "accepted");
			assert.equal(d.disposition, "done");
			assert.equal(d.actual_change, "abc123");
			assert.deepEqual((await getProposalAssertionsForKey(db, "ik-1")).map((a) => a.subject_key), ["ik-1"]);

			// Reads go through assertions and reconcile cleanly against the legacy view.
			const r = await reconcileDecisionsMigration(db);
			assert.equal(r.legacyDecisions, r.assertionDecisions);
			assert.deepEqual(r.missingDecisions, []);
			assert.deepEqual(r.extraAssertions, []);
		} finally {
			await close();
		}
	});

	it("keeps decisions keyed by the content-addressed input_key (durable across regenerate)", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertProposalRow(db, { id: "pA", sessionId: "s1", title: "A", inputKey: "ik-same" });
			assert.equal(await acceptProposal(db, "pA", { rationale: "keyed on the input_key" }), true);

			// The decision assertion is keyed by the proposal_input_key, not the row id
			// — the wipe-durability contract. A regenerated proposal that re-derives
			// the same input_key re-attaches to this decision.
			const rows = await getProposalAssertionsForKey(db, "ik-same");
			assert.equal(rows.length, 1);
			assert.equal(rows[0]!.subject_key, "ik-same");
			assert.equal(rows[0]!.verdict, "accepted");
			// The assertion id is content-addressed, not a random row id.
			assert.match(rows[0]!.id, /^[0-9a-f]{16}$/);
			// Two proposals cannot share the decision: keying is by input_key alone.
			await insertProposalRow(db, { id: "pB", sessionId: "s1", title: "B", inputKey: "ik-other" });
			assert.equal(await acceptProposal(db, "pB"), true);
			assert.equal((await getAllDecisions(db)).length, 2);
		} finally {
			await close();
		}
	});

	it("migrate() auto-folds legacy data and is idempotent", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			// Simulate a DB that predates the migration: write legacy rows, then
			// re-run migrate() as any command open would — the backfill runs and is
			// idempotent.
			await insertLegacyDecision(db, { ik: "ik-1", decision: "accepted" });
			await insertLegacyRemediation(db, "rem-1", "one fix");
			const before = ((await db.prepare("SELECT COUNT(*) AS c FROM assertions WHERE subject_kind = 'proposal'").get()) as { c: number }).c;
			await migrate(db);
			const after = ((await db.prepare("SELECT COUNT(*) AS c FROM assertions WHERE subject_kind = 'proposal'").get()) as { c: number }).c;
			assert.equal(after, before + 1, "migrate() folded the pending legacy decision");
			await migrate(db); // idempotent
			await migrate(db);
			const finalCount = ((await db.prepare("SELECT COUNT(*) AS c FROM assertions WHERE subject_kind = 'proposal'").get()) as { c: number }).c;
			assert.equal(finalCount, after, "re-running migrate() never duplicates");
			assert.equal((await getRemediationAssertion(db, "rem-1"))?.reason, "one fix");
		} finally {
			await close();
		}
	});

	it("remediate writes the shared remediation assertion and groups decisions", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertProposalRow(db, { id: "p1", sessionId: "s1", title: "A", inputKey: "ik-1" });
			await insertProposalRow(db, { id: "p2", sessionId: "s1", title: "B", inputKey: "ik-2" });

			const res = await acceptProposalsWithRemediation(db, ["p1", "p2"], { description: "consolidated", actual_change: "sha" }, { disposition: "done" });
			assert.ok(res.remediationId);

			// A remediation assertion exists, and both decisions group under it.
			const rem = (await getRemediationAssertion(db, res.remediationId!))!;
			assert.equal(rem.subject_key, res.remediationId);
			assert.equal(rem.reason, "consolidated");
			assert.equal(rem.actual_change, "sha");
			const decs = await getProposalAssertionsForKey(db, "ik-1");
			assert.equal(decs[0]!.remediation_id, res.remediationId);
			assert.equal((await getDecisionsForRemediation(db, res.remediationId!)).length, 2);
			assert.equal((await getLatestDecision(db, "ik-2"))!.disposition, "done");

			const r = await reconcileDecisionsMigration(db);
			assert.equal(r.legacyDecisions, r.assertionDecisions);
			assert.equal(r.legacyRemediations, r.assertionRemediations);
			assert.deepEqual(r.missingDecisions, []);
			assert.deepEqual(r.missingRemediations, []);
		} finally {
			await close();
		}
	});
});
