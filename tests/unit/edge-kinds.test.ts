import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EDGE_KINDS, REF_KINDS, isEdgeKind, isRefKind, validateEdge } from "../../src/analyze/edge-kinds.js";

describe("edge kinds", () => {
	it("recognises valid edge and ref kinds", () => {
		assert.ok(isEdgeKind(EDGE_KINDS.ANCHORS));
		assert.ok(isEdgeKind(EDGE_KINDS.REVISES));
		assert.ok(isRefKind(REF_KINDS.SESSION));
		assert.ok(!isEdgeKind("bogus"));
		assert.ok(!isRefKind("bogus"));
	});

	it("accepts allowed edge → ref combinations", () => {
		assert.doesNotThrow(() => validateEdge(EDGE_KINDS.ANCHORS, REF_KINDS.SESSION));
		assert.doesNotThrow(() => validateEdge(EDGE_KINDS.ANCHORS, REF_KINDS.MESSAGE));
		assert.doesNotThrow(() => validateEdge(EDGE_KINDS.CONSUMES, REF_KINDS.ANALYSIS_NODE));
		assert.doesNotThrow(() => validateEdge(EDGE_KINDS.USES_PROMPT, REF_KINDS.PROMPT_VERSION));
		assert.doesNotThrow(() => validateEdge(EDGE_KINDS.USES_CONFIG, REF_KINDS.CONFIG_VERSION));
		assert.doesNotThrow(() => validateEdge(EDGE_KINDS.PRODUCES, REF_KINDS.PROPOSAL));
		assert.doesNotThrow(() => validateEdge(EDGE_KINDS.REVISES, REF_KINDS.ANALYSIS_NODE));
	});

	it("rejects disallowed edge → ref combinations", () => {
		assert.throws(() => validateEdge(EDGE_KINDS.ANCHORS, REF_KINDS.PROPOSAL), /cannot target/);
		assert.throws(() => validateEdge(EDGE_KINDS.CONSUMES, REF_KINDS.SESSION), /cannot target/);
	});

	it("rejects unknown kinds", () => {
		assert.throws(() => validateEdge("nope", REF_KINDS.SESSION), /Invalid edge_kind/);
		assert.throws(() => validateEdge(EDGE_KINDS.ANCHORS, "nope"), /Invalid to_ref_kind/);
	});
});
