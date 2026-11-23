import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { headSubjectKey, repairEdges, type LineageHead } from "../../src/analyze/lineage.js";

function head(id: string, version: string, createdAt: string, runId = `run-${id}`): LineageHead {
	return {
		id,
		session_id: "s1",
		output_key: `ok-${id}`,
		run_id: runId,
		created_at: createdAt,
		analyzer_version_id: version,
		anchor_ref: "s1",
		content_json: null,
	};
}

describe("repairEdges", () => {
	it("keeps the last-written node of a subject when the versions are equal", () => {
		const edges = repairEdges([head("a", "1.0", "2026-01-01"), head("b", "1.0", "2026-01-02")], undefined);
		assert.deepEqual(edges, [{ fromNodeId: "b", toOutputKey: "ok-a" }]);
	});

	it("keeps the node of the newest analyzer version, even when an older version wrote later", () => {
		// A downgraded run wrote "old" after "new". The framework never lets an older
		// version revise a newer node, so "new" is the node it would have left current.
		const edges = repairEdges([head("new", "1.3", "2026-01-01"), head("old", "1.2", "2026-01-02")], undefined);
		assert.deepEqual(edges, [{ fromNodeId: "new", toOutputKey: "ok-old" }]);
	});

	it("compares versions as numbers, not as text", () => {
		const edges = repairEdges([head("ten", "1.10", "2026-01-01"), head("nine", "1.9", "2026-01-02")], undefined);
		assert.deepEqual(edges, [{ fromNodeId: "ten", toOutputKey: "ok-nine" }]);
	});
});

describe("headSubjectKey", () => {
	it("keeps the anchor in the key, so one named subject on two turns is two subjects", () => {
		const content = JSON.stringify({ claim: "src/index.ts" });
		const subjectOfNode = (c: Record<string, unknown>) => String(c["claim"]);
		const turn1 = { ...head("a", "1.0", "2026-01-01"), anchor_ref: "turn-1", content_json: content };
		const turn2 = { ...head("b", "1.0", "2026-01-02"), anchor_ref: "turn-2", content_json: content };
		assert.notEqual(headSubjectKey(turn1, subjectOfNode), headSubjectKey(turn2, subjectOfNode));
		assert.deepEqual(repairEdges([turn1, turn2], subjectOfNode), [], "neither revises the other");
	});
});
