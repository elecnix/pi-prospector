/**
 * Current-generation reads (issue #260).
 *
 * The graph is append-only, so revising an analyzer leaves every superseded
 * generation live. The aggregate surfaces — `prospect stats` and `prospect
 * nodes` — must count the *current* generation: a live node with no incoming
 * `revises` edge from a live node. Supersession is read from the edge the
 * recomputation wrote, never guessed from the version or the timestamp.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession } from "./helpers.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";
import {
	insertNode,
	insertEdge,
	listAnalysisNodes,
	countAnalysisNodes,
	getAnalysisStats,
} from "../../src/db/analysis-queries.js";
import { EDGE_KINDS, REF_KINDS } from "../../src/analyze/edge-kinds.js";
import { readNodes } from "../../src/commands/nodes.js";

const T1 = "2027-01-01T00:00:00.000Z";
const T2 = "2027-02-01T00:00:00.000Z";
const T3 = "2027-03-01T00:00:00.000Z";
const T4 = "2027-04-01T00:00:00.000Z";

async function seedNode(
	db: AsyncDatabase,
	id: string,
	opts: { version: string; at: string; unit?: string; analyzer?: string; kind?: string; content?: string },
): Promise<void> {
	await insertNode(db, {
		id,
		sessionId: "s1",
		analyzerId: opts.analyzer ?? "a",
		analyzerVersionId: opts.version,
		configId: "c",
		runId: null,
		nodeKind: opts.kind ?? "metric",
		contentJson: opts.content ?? "{}",
		sourceSetHash: opts.unit ?? "unit-1",
		inputKey: `ik-${id}`,
		outputKey: `ok-${id}`,
		createdAt: opts.at,
	});
}

/** `successor` revises `predecessor`, referenced by its output_key as the framework writes it. */
async function revise(db: AsyncDatabase, successor: string, predecessor: string): Promise<void> {
	await insertEdge(db, {
		fromNodeId: successor,
		toRefKind: REF_KINDS.ANALYSIS_NODE,
		toRefId: `ok-${predecessor}`,
		edgeKind: EDGE_KINDS.REVISES,
		ordinal: 0,
	});
}

async function retract(db: AsyncDatabase, id: string, at: string): Promise<void> {
	await db.prepare("UPDATE analysis_nodes SET retracted_at = ?, retracted_by_run = 'gc' WHERE id = ?").run(at, id);
}

async function ids(db: AsyncDatabase, filter: Parameters<typeof listAnalysisNodes>[1] = {}): Promise<string[]> {
	return (await listAnalysisNodes(db, filter)).map((n) => n.id).sort();
}

describe("current-generation node reads (#260)", () => {
	it("counts only the head of each revises chain; superseded generations are opt-in", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			// unit-1: v1 → v2 → v3. unit-2: a single, never-revised node.
			await seedNode(db, "v1", { version: "1.0", at: T1 });
			await seedNode(db, "v2", { version: "2.0", at: T2 });
			await revise(db, "v2", "v1");
			await seedNode(db, "v3", { version: "3.0", at: T3 });
			await revise(db, "v3", "v2");
			await seedNode(db, "solo", { version: "1.0", at: T1, unit: "unit-2" });

			assert.deepEqual(await ids(db), ["solo", "v3"]);
			assert.equal(await countAnalysisNodes(db), 2);
			assert.deepEqual(await ids(db, { allVersions: true }), ["solo", "v1", "v2", "v3"]);
			assert.equal(await countAnalysisNodes(db, { allVersions: true }), 4);

			const stats = await getAnalysisStats(db);
			assert.equal(stats.nodes, 2);
			assert.equal(stats.supersededNodes, 2);
			assert.deepEqual(stats.nodesByAnalyzer, { a: 2 });
			assert.deepEqual(stats.nodesByKind, { metric: 2 });
		} finally {
			await close();
		}
	});

	it("follows the edge, not the version: a downgrade's revision is current", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			// A bad 3.0 is reverted: the re-run at 2.1 declares it replaces 3.0.
			await seedNode(db, "v3", { version: "3.0", at: T1 });
			await seedNode(db, "v21", { version: "2.1", at: T2 });
			await revise(db, "v21", "v3");
			assert.deepEqual(await ids(db), ["v21"]);
		} finally {
			await close();
		}
	});

	it("follows the edge, not recency: an unrevised node is current however old", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			// Two nodes over the same unit with no lineage between them: neither
			// declared that it supersedes the other, so both are current.
			await seedNode(db, "old", { version: "1.0", at: T1 });
			await seedNode(db, "new", { version: "1.0", at: T2 });
			assert.deepEqual(await ids(db), ["new", "old"]);
		} finally {
			await close();
		}
	});

	it("a retracted successor does not supersede: its predecessor is current again", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await seedNode(db, "v1", { version: "1.0", at: T1 });
			await seedNode(db, "v2", { version: "2.0", at: T2 });
			await revise(db, "v2", "v1");
			await retract(db, "v2", T3);
			assert.deepEqual(await ids(db), ["v1"]);
		} finally {
			await close();
		}
	});

	it("a live head whose predecessor is retracted is current", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await seedNode(db, "v1", { version: "1.0", at: T1 });
			await seedNode(db, "v2", { version: "2.0", at: T2 });
			await revise(db, "v2", "v1");
			await retract(db, "v1", T3);
			assert.deepEqual(await ids(db), ["v2"]);
			assert.deepEqual(await ids(db, { allVersions: true }), ["v2"]);
		} finally {
			await close();
		}
	});

	it("as-of reads grade currency by the graph at T", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await seedNode(db, "v1", { version: "1.0", at: T1 });
			await seedNode(db, "v2", { version: "2.0", at: T3 });
			await revise(db, "v2", "v1");
			// Before the revision existed, v1 was the current generation.
			assert.deepEqual(await ids(db, { asOf: T2 }), ["v1"]);
			assert.equal(await countAnalysisNodes(db, { asOf: T2 }), 1);
			assert.equal((await getAnalysisStats(db, T2)).nodes, 1);
			// After it, v2 supersedes v1.
			assert.deepEqual(await ids(db, { asOf: T4 }), ["v2"]);
			assert.equal((await getAnalysisStats(db, T4)).nodes, 1);
			assert.equal((await getAnalysisStats(db, T4)).supersededNodes, 1);
			assert.deepEqual(await ids(db, { asOf: T4, allVersions: true }), ["v1", "v2"]);
			// A successor retracted by T no longer supersedes at T.
			await retract(db, "v2", T4);
			assert.deepEqual(await ids(db, { asOf: T4 }), ["v1"]);
		} finally {
			await close();
		}
	});

	it("prospect nodes --counts describes the current generation; --all-versions opts in", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await seedNode(db, "v1", { version: "1.0", at: T1, content: '{"label":"old"}' });
			await seedNode(db, "v2", { version: "2.0", at: T2, content: '{"label":"new"}' });
			await revise(db, "v2", "v1");

			const current = await readNodes(db, { analyzerId: "a", filters: [], counts: "label" });
			assert.equal(current.total, 1);
			assert.match(current.text, /1 shown of 1 matching \(1 current before filters\)/);
			assert.match(current.text, /new: 1/);
			assert.doesNotMatch(current.text, /old: 1/);

			const all = await readNodes(db, { analyzerId: "a", filters: [], counts: "label", allVersions: true });
			assert.equal(all.total, 2);
			assert.match(all.text, /all versions/);
			assert.match(all.text, /2 live before filters/);
			assert.match(all.text, /old: 1/);
		} finally {
			await close();
		}
	});
});
