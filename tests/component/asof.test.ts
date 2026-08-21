import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertProposalRow } from "./helpers.js";
import { insertNode, getAllAnalysisNodes } from "../../src/db/analysis-queries.js";
import { parseFlags, parseTimestamp, parseRelative } from "../../src/timepoint.js";
import { listProposalsAsOf, getStats } from "../../src/db/queries.js";

function seedNodeAt(db: import("better-sqlite3").Database, id: string, at: string, analyzer = "a", outputKey = `out-${id}`): void {
	insertNode(db, {
		id,
		sessionId: "s1",
		analyzerId: analyzer,
		analyzerVersionId: "1",
		configId: "c",
		runId: null,
		nodeKind: "metric",
		contentJson: "{}",
		sourceSetHash: "ssh",
		inputKey: `ih-${id}`,
		outputKey,
		createdAt: at,
	});
}

const T1 = "2027-01-01T00:00:00.000Z";
const T2 = "2027-06-01T00:00:00.000Z";
const T3 = "2027-12-01T00:00:00.000Z";

describe("timepoint helpers", () => {
	it("parseTimestamp accepts ISO and relative durations", () => {
		assert.equal(parseTimestamp(T1), T1);
		const rel = parseRelative("7d");
		assert.equal(rel, 7 * 24 * 60 * 60 * 1000);
		// relative resolves to an absolute now-based ISO
		const parsed = parseTimestamp("7d");
		assert.ok(!Number.isNaN(Date.parse(parsed)));
		assert.throws(() => parseTimestamp("garbage"));
		assert.throws(() => parseTimestamp(""));
	});

	it("parseFlags handles --flag value, --flag=value, and bare flags", () => {
		const r = parseFlags("alpha beta --as-of 2025-01-01T00:00:00Z --full --limit=5");
		assert.deepEqual(r.positionals, ["alpha", "beta"]);
		assert.equal(r.flags["as-of"], "2025-01-01T00:00:00Z");
		assert.equal(r.flags["full"], "");
		assert.equal(r.flags["limit"], "5");
	});
});

describe("as-of reads (#50)", () => {
	it("getAllAnalysisNodes filters by created_at", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			seedNodeAt(db, "n1", T1);
			seedNodeAt(db, "n2", T2);
			seedNodeAt(db, "n3", T3);
			assert.equal(getAllAnalysisNodes(db).length, 3);
			assert.equal(getAllAnalysisNodes(db, T2).length, 2);
			assert.equal(getAllAnalysisNodes(db, T1).length, 1);
		} finally {
await close();
		}
	});

	it("getStats as-of counts only nodes present by T", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			seedNodeAt(db, "n1", T1);
			seedNodeAt(db, "n2", T3);
			assert.equal((((await getStats(db)).analysis)).nodes, 2);
			assert.equal((((await getStats(db, T2)).analysis)).nodes, 1);
		} finally {
await close();
		}
	});

	it("listProposalsAsOf reconstructs status from the decision log", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertProposalRow(db, { id: "p1", sessionId: "s1", title: "One", status: "applied", inputKey: "ik-p1" });
			await insertProposalRow(db, { id: "p2", sessionId: "s1", title: "Two", status: "rejected", inputKey: "ik-p2" });
			await insertProposalRow(db, { id: "p3", sessionId: "s1", title: "Three", status: "open", inputKey: "ik-p3" });

			const push = (id: string, key: string, decision: string, at: string) =>
				db
					.prepare("INSERT INTO proposal_decisions (id, proposal_input_key, decision, decided_at) VALUES (?, ?, ?, ?)")
					.run(id, key, decision, at);

			// p1 accepted at T2, then its decision is overwritten by a later decision? no.
			push("d1", "ik-p1", "accepted", T2);
			push("d2", "ik-p2", "rejected", T2);
			// p1 decided after T1, so at T1 it must still be open.
			const atT1 = listProposalsAsOf(db, T1);
			// proposals created by T1 (all have created_at = now, but the filter is
			// created_at <= T; insertProposalRow uses now() so they exist at all T).
			const byId = new Map(atT1.map((p) => [p.id, p.status]));
			assert.equal(byId.get("p1"), "open");
			assert.equal(byId.get("p2"), "open");
			assert.equal(byId.get("p3"), "open");

			const atT2 = listProposalsAsOf(db, T2);
			const byId2 = new Map(atT2.map((p) => [p.id, p.status]));
			assert.equal(byId2.get("p1"), "applied");
			assert.equal(byId2.get("p2"), "rejected");
			assert.equal(byId2.get("p3"), "open");
		} finally {
await close();
		}
	});
});
