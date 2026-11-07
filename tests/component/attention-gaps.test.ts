/**
 * Component tests for the attention-gaps analyzer, exercised end-to-end through
 * the real AnalyzerFramework with its dependencies. Hand-written synthetic rows,
 * no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	tempDb,
	insertSession,
	insertMessages,
	mockFramework,
	readAnalyzerNodes,
	nodeEdges,
	type TestMessage,
} from "./helpers.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { messageOriginAnalyzer } from "../../src/analyze/analyzers/message-origin/index.js";
import { attentionGapsAnalyzer, type AttentionGapsProperties } from "../../src/analyze/analyzers/attention-gaps/index.js";

const T = (s: string) => `2026-10-01T${s}.000Z`;

function conversation(): TestMessage[] {
	return [
		{ role: "user", text: "Please fix the failing build.", timestamp: T("10:00:00") },
		{ role: "assistant", text: "Fixed.", timestamp: T("10:00:20") },
		{ role: "user", text: "Now add a test for it.", timestamp: T("10:01:20") },
		{ role: "assistant", text: "Added.", timestamp: T("10:01:40") },
	];
}

async function run(db: import("better-sqlite3").Database, id: string, messages: TestMessage[]) {
	await insertSession(db, id);
	const ids = await insertMessages(db, id, messages);
	const fw = mockFramework(db);
	await fw.register(turnPairCoreAnalyzer);
	await fw.register(messageOriginAnalyzer);
	await fw.register(attentionGapsAnalyzer);
	const summary = await fw.run(id, {});
	assert.equal(summary.errors.length, 0, summary.errors.join("; "));
	return { ids, fw };
}

describe("attention-gaps component test", () => {
	it("measures the typed message's gap and consumes the origin nodes", async () => {
		const { db, close } = await tempDb();
		try {
			await run(db, "ag-1", conversation());
			const nodes = await readAnalyzerNodes(db, "attention-gaps");
			assert.equal(nodes.length, 1);
			assert.equal(nodes[0]!.node_kind, "metric");
			const content = JSON.parse(nodes[0]!.content_json) as AttentionGapsProperties;
			assert.equal(content.typed_message_count, 2);
			assert.equal(content.gap_count, 1);
			assert.equal(content.sum_seconds, 60);
			assert.equal(content.unmeasured_typed_count, 1);

			const edges = await nodeEdges(db, nodes[0]!.id);
			assert.equal(edges.filter((e) => e["edge_kind"] === "anchors" && e["to_ref_kind"] === "session").length, 1);
			assert.equal(edges.filter((e) => e["edge_kind"] === "consumes").length, 2, "one consumed origin node per message");
			const proposals = (await db
				.prepare("SELECT COUNT(*) AS c FROM proposals WHERE analyzer_id = 'attention-gaps'")
				.get()) as unknown as { c: number };
			assert.equal(proposals.c, 0);
		} finally {
			await close();
		}
	});

	it("a plain re-run is a no-op fill", async () => {
		const { db, close } = await tempDb();
		try {
			const { fw } = await run(db, "ag-rerun", conversation());
			const before = (await readAnalyzerNodes(db, "attention-gaps")).map((n) => n.output_key);
			await fw.run("ag-rerun", {});
			assert.deepEqual((await readAnalyzerNodes(db, "attention-gaps")).map((n) => n.output_key), before);
		} finally {
			await close();
		}
	});

	it("gives a session with no user-role message a zero-count node", async () => {
		const { db, close } = await tempDb();
		try {
			await run(db, "ag-agent-only", [
				{ role: "assistant", text: "Scheduled run started.", timestamp: T("10:00:00") },
				{ role: "assistant", text: "Scheduled run finished.", timestamp: T("10:00:30") },
			]);
			const nodes = await readAnalyzerNodes(db, "attention-gaps");
			assert.equal(nodes.length, 1);
			const content = JSON.parse(nodes[0]!.content_json) as AttentionGapsProperties;
			assert.equal(content.typed_message_count, 0);
			assert.equal(content.median_seconds, null);
		} finally {
			await close();
		}
	});

	it("plans nothing for an empty transcript", async () => {
		const { db, close } = await tempDb();
		try {
			await run(db, "ag-empty", []);
			assert.equal((await readAnalyzerNodes(db, "attention-gaps")).length, 0);
		} finally {
			await close();
		}
	});
});
