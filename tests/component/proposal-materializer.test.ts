import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession } from "./helpers.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";
import { computeProposalInputKey, materializeProposalsFromNode } from "../../src/analyze/proposal-materializer.js";
import { insertNode } from "../../src/db/analysis-queries.js";
import { listProposals } from "../../src/db/queries.js";

async function seedNode(db: AsyncDatabase, id: string): Promise<void> {
	await insertNode(db, {
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
	it("inserts valid proposals and links them with produces edges", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await seedNode(db, "node1");
			const created = await materializeProposalsFromNode(db, {
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

			const proposals = await listProposals(db);
			assert.equal(proposals.length, 1);
			assert.equal(proposals[0]!.target_type, "agents_md");
			assert.equal(proposals[0]!.status, "open");

			const edge = (await db
				.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ? AND edge_kind = 'produces'")
				.get("node1")) as { to_ref_id: string } | undefined;
			assert.ok(edge);
			assert.equal(edge!.to_ref_id, proposals[0]!.id);
		} finally {
			await close();
		}
	});

	it("is idempotent for the same source node, but keeps duplicates from distinct sources", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await seedNode(db, "n1");
			await seedNode(db, "n2");
			const payload = {
				improvement_proposals: [{ target_type: "config", title: "Same thing", summary: "s", severity: "friction" }],
			};
			// Same source node, materialised twice → idempotent (keyed on source output_key + ordinal).
			assert.equal(await materializeProposalsFromNode(db, { sessionId: "s1", analyzerId: "a", sourceNodeId: "n1", sourceOutputKey: "ok-n1", now: new Date().toISOString(), contentJson: payload }), 1);
			assert.equal(await materializeProposalsFromNode(db, { sessionId: "s1", analyzerId: "a", sourceNodeId: "n1", sourceOutputKey: "ok-n1", now: new Date().toISOString(), contentJson: payload }), 0);
			// Distinct source node with byte-identical text → intentionally retained.
			assert.equal(await materializeProposalsFromNode(db, { sessionId: "s1", analyzerId: "a", sourceNodeId: "n2", sourceOutputKey: "ok-n2", now: new Date().toISOString(), contentJson: payload }), 1);
			assert.equal((await listProposals(db)).length, 2);
		} finally {
			await close();
		}
	});

	it("does not resurrect a decided proposal on re-materialise (status preserved)", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await seedNode(db, "n1");
			const payload = {
				improvement_proposals: [{ target_type: "agents_md", title: "Add a rule", summary: "s", severity: "friction" }],
			};
			const mk = () => ({ sessionId: "s1", analyzerId: "a", sourceNodeId: "n1", sourceOutputKey: "ok-n1", now: new Date().toISOString(), contentJson: payload });
			assert.equal(await materializeProposalsFromNode(db, mk()), 1);
			const p = (await listProposals(db))[0]!;

			// Human decides on it: flip out of 'open'.
			await db.prepare("UPDATE proposals SET status = 'rejected', updated_at = ? WHERE id = ?").run(new Date().toISOString(), p.id);

			// A later analysis run re-materialises the same source node. The decided
			// proposal must NOT be re-created as a fresh 'open' row.
			assert.equal(await materializeProposalsFromNode(db, mk()), 0, "must not re-create a decided proposal");
			const all = await listProposals(db);
			assert.equal(all.length, 1, "exactly one row for the input_key");
			assert.equal(all[0]!.id, p.id, "same row preserved");
			assert.equal(all[0]!.status, "rejected", "human decision preserved across recompute");
		} finally {
			await close();
		}
	});

	it("returns 0 when there are no proposals", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await seedNode(db, "n1");
			assert.equal(await materializeProposalsFromNode(db, { sessionId: "s1", analyzerId: "a", sourceNodeId: "n1", sourceOutputKey: "ok-n1", now: new Date().toISOString(), contentJson: {} }), 0);
			assert.equal(await materializeProposalsFromNode(db, { sessionId: "s1", analyzerId: "a", sourceNodeId: "n1", sourceOutputKey: "ok-n1", now: new Date().toISOString(), contentJson: { improvement_proposals: "not-an-array" } }), 0);
		} finally {
			await close();
		}
	});
});

describe("proposal pricing (issue #71)", () => {
	// Session stream: u0 → a1($0.2) a2($0.3) → u1 → a3($0.1). Turn costs are the
	// sum of assistant billing from a user message up to the next one.
	async function seedPaidSession(db: AsyncDatabase): Promise<void> {
		await insertSession(db, "s1");
		const insert = db.prepare(
			"INSERT INTO messages (id, session_id, role, cost_usd) VALUES (?, 's1', ?, ?)",
		);
		await insert.run("u0", "user", null);
		await insert.run("a1", "assistant", 0.2);
		await insert.run("a2", "assistant", 0.3);
		await insert.run("u1", "user", null);
		await insert.run("a3", "assistant", 0.1);
	}

	async function materializeWith(db: AsyncDatabase, sourceIds: string[] | undefined): Promise<number | null> {
		await seedNode(db, "n1");
		const created = await materializeProposalsFromNode(db, {
			sessionId: "s1",
			analyzerId: "session-overview",
			sourceNodeId: "n1",
			sourceOutputKey: "ok-n1",
			now: new Date().toISOString(),
			contentJson: {
				improvement_proposals: [{ target_type: "prompt", title: "T", summary: "s", source_message_ids: sourceIds }],
			},
		});
		assert.equal(created, 1);
		return (await listProposals(db))[0]!.cost_usd;
	}

	it("prices a proposal as the billed cost of its source turns", async () => {
		const { db, close } = await tempDb();
		try {
			await seedPaidSession(db);
			assert.equal(await materializeWith(db, ["u1"]), 0.1);
		} finally {
			await close();
		}
	});

	it("sums all assistant turns in a multi-step source turn", async () => {
		const { db, close } = await tempDb();
		try {
			await seedPaidSession(db);
			assert.equal(await materializeWith(db, ["u0"]), 0.5); // a1 + a2, stops at the next user
		} finally {
			await close();
		}
	});

	it("leaves a proposal unpriced (null) when it carries no source turns", async () => {
		const { db, close } = await tempDb();
		try {
			await seedPaidSession(db);
			assert.equal(await materializeWith(db, undefined), null);
		} finally {
			await close();
		}
	});

	it("leaves a proposal unpriced (null) when its source turns have no recorded cost", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1"); // seedNode's node session
			await insertSession(db, "s2");
			const stmt = db.prepare("INSERT INTO messages (id, session_id, role) VALUES (?, 's2', ?)");
			await stmt.run("u0", "user");
			await stmt.run("a1", "assistant");
			await seedNode(db, "n2");
			const created = await materializeProposalsFromNode(db, {
				sessionId: "s2",
				analyzerId: "session-overview",
				sourceNodeId: "n2",
				sourceOutputKey: "ok-n2",
				now: new Date().toISOString(),
				contentJson: { improvement_proposals: [{ target_type: "prompt", title: "T", summary: "s", source_message_ids: ["u0"] }] },
			});
			assert.equal(created, 1);
			assert.equal((await listProposals(db))[0]!.cost_usd, null);
		} finally {
			await close();
		}
	});
});