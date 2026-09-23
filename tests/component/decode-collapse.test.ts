/**
 * Component tests for the decode-collapse analyzer (issue #277), exercised
 * end-to-end through the real AnalyzerFramework over synthetic sessions in a
 * real SQLite database. No real session data, no network: the analyzer never
 * touches the LLM seam.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AsyncDatabase } from "../../src/db/async-db.js";
import {
	tempDb,
	insertSession,
	insertMessages,
	mockFramework,
	mockFrameworkWithOverrides,
	readAnalyzerNodes,
	assertPlainRerunIsNoOpFill,
	sessionProposals,
	nodeEdges,
	type TestMessage,
} from "./helpers.js";
import { decodeCollapseAnalyzer, type DecodeCollapseProperties } from "../../src/analyze/analyzers/decode-collapse/index.js";
import type { AnalysisNodeRow } from "../../src/analyze/types.js";
import { coherentText, collapsedText, prng } from "../fixtures/decode-collapse-text.js";

const ANALYZER_ID = "decode-collapse";
const COLLAPSED_ID = "collapsed-message";

function coherentSession(rand: () => number, messages = 8): TestMessage[] {
	const out: TestMessage[] = [{ role: "user", text: "Please fix the failing build." }];
	for (let i = 0; i < messages; i++) out.push({ role: "assistant", thinking: coherentText(rand), text: "Done.", model: "prov/model-a" });
	return out;
}

function collapsedSession(rand: () => number): TestMessage[] {
	return [
		...coherentSession(rand, 6),
		{ role: "user", text: "And the migration too, please." },
		{ id: COLLAPSED_ID, role: "assistant", thinking: collapsedText(rand, 6), text: "", model: "prov/model-b" },
	];
}

/** `count` sessions with strictly increasing start times, in id order. */
async function seed(db: AsyncDatabase, count: number, collapsedAt?: number): Promise<string[]> {
	const rand = prng(2026);
	const ids: string[] = [];
	for (let i = 0; i < count; i++) {
		const id = `dc-${String(i).padStart(2, "0")}`;
		await insertSession(db, id);
		await db.prepare("UPDATE sessions SET started_at = ? WHERE id = ?").run(new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), id);
		await insertMessages(db, id, i === collapsedAt ? collapsedSession(rand) : coherentSession(rand));
		ids.push(id);
	}
	return ids;
}

function props(node: AnalysisNodeRow): DecodeCollapseProperties {
	return JSON.parse(node.content_json) as DecodeCollapseProperties;
}

async function nodeFor(db: AsyncDatabase, sessionId: string): Promise<AnalysisNodeRow> {
	const node = (await readAnalyzerNodes(db, ANALYZER_ID)).find((n) => props(n).session_id === sessionId);
	assert.ok(node, `a node for ${sessionId}`);
	return node;
}

describe("decode-collapse (component)", () => {
	it("flags a collapsed generation, anchors it, and materialises a config proposal", async () => {
		const { db, close } = await tempDb();
		try {
			const ids = await seed(db, 20, 5);
			const fw = mockFramework(db);
			await fw.register(decodeCollapseAnalyzer);
			for (const id of ids) {
				const summary = await fw.run(id, {});
				assert.equal(summary.errors.length, 0, summary.errors.join("; "));
			}

			const bad = await nodeFor(db, "dc-05");
			const p = props(bad);
			assert.equal(bad.node_kind, "proposal");
			assert.equal(p.model_status, "ready");
			assert.equal(p.collapsed_count, 1);
			const flagged = p.collapsed_documents[0]!;
			assert.equal(flagged.message_id, COLLAPSED_ID);
			assert.equal(flagged.field, "thinking");
			assert.equal(flagged.answer_empty, true);
			assert.equal(flagged.cross_session_share, 0);
			assert.ok(flagged.control_tokens.includes("</tool_call>"));
			assert.equal(p.top_documents[0]!.message_id, COLLAPSED_ID, "the collapsed document heads the tail a person confirms");
			assert.ok(p.calibration && flagged.perplexity! > p.calibration.threshold);

			const edges = await nodeEdges(db, bad.id);
			assert.ok(edges.some((e) => e["edge_kind"] === "anchors" && e["to_ref_id"] === COLLAPSED_ID));

			const proposals = await sessionProposals(db, "dc-05", ANALYZER_ID);
			assert.equal(proposals.length, 1);
			assert.equal(proposals[0]!["target_type"], "config");
			assert.equal(proposals[0]!["target_path"], "prov/model-b");

			for (const id of ids.filter((i) => i !== "dc-05")) {
				const clean = props(await nodeFor(db, id));
				assert.equal(clean.collapsed_count, 0, `${id} is coherent`);
				assert.equal(clean.improvement_proposals.length, 0);
			}
		} finally {
			await close();
		}
	});

	it("a corpus too small to train on records the count as unknown, not zero", async () => {
		const { db, close } = await tempDb();
		try {
			const [id] = await seed(db, 3, 0);
			const fw = mockFramework(db);
			await fw.register(decodeCollapseAnalyzer);
			assert.equal((await fw.run(id!, {})).errors.length, 0);
			const p = props(await nodeFor(db, id!));
			assert.equal(p.model_status, "insufficient_corpus");
			assert.equal(p.collapsed_count, null);
			assert.equal(p.calibration, null);
			assert.ok(p.document_count > 0);
			assert.deepEqual(p.top_documents, []);
		} finally {
			await close();
		}
	});

	it("a plain re-run is a no-op fill", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, 12);
			await assertPlainRerunIsNoOpFill(mockFramework(db), decodeCollapseAnalyzer, "dc-00", () => readAnalyzerNodes(db, ANALYZER_ID));
		} finally {
			await close();
		}
	});

	it("a session newer than a full reference leaves existing nodes current", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, 6);
			const overrides = { maxReferenceSessions: 5, minTrainingSessions: 2, minHeldOutDocuments: 4 };
			const fw = mockFrameworkWithOverrides(db, ANALYZER_ID, overrides);
			await fw.register(decodeCollapseAnalyzer);
			assert.equal((await fw.run("dc-00", {})).errors.length, 0);
			const before = await readAnalyzerNodes(db, ANALYZER_ID);

			// dc-06 starts after every reference session, so the reference is unchanged.
			const rand = prng(1);
			await insertSession(db, "dc-06");
			await db.prepare("UPDATE sessions SET started_at = ? WHERE id = ?").run("2027-01-01T00:00:00.000Z", "dc-06");
			await insertMessages(db, "dc-06", coherentSession(rand));

			const fw2 = mockFrameworkWithOverrides(db, ANALYZER_ID, overrides);
			await fw2.register(decodeCollapseAnalyzer);
			const again = await fw2.run("dc-00", {});
			assert.equal(again.errors.length, 0);
			assert.equal(again.nodesProduced, 0);
			assert.deepEqual((await readAnalyzerNodes(db, ANALYZER_ID)).map((n) => n.input_key), before.map((n) => n.input_key));
		} finally {
			await close();
		}
	});

	it("a session with nothing to score plans no unit", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "tiny");
			await insertMessages(db, "tiny", [{ role: "user", text: "hi" }, { role: "assistant", text: "Hello." }]);
			const fw = mockFramework(db);
			await fw.register(decodeCollapseAnalyzer);
			assert.equal((await fw.run("tiny", {})).errors.length, 0);
			assert.equal((await readAnalyzerNodes(db, ANALYZER_ID)).length, 0);
		} finally {
			await close();
		}
	});
});
