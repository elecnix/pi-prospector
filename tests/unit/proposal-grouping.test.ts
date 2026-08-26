import { test } from "node:test";
import assert from "node:assert/strict";
import { nestProposals, serialiseGrouped, renderGroupedProposals, type SupportMap } from "../../src/commands/grouping.js";
import type { Proposal } from "../../src/types.js";

function makeProposal(overrides: Partial<Proposal>): Proposal {
	return {
		id: "id",
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		session_id: "sess",
		source_node_id: null,
		analyzer_id: "session-overview",
		target_type: "agents_md",
		target_path: null,
		title: "t",
		severity: "friction",
		summary: "s",
		detail: null,
		evidence: null,
		confidence: null,
		cost_usd: null,
		status: "open",
		input_key: "k",
		source_message_ids: null,
		validated_score: null,
		validation_status: "unvalidated",
		validation_node_id: null,
		...overrides,
	};
}

/** Synthetic fixture: one general proposal over two specific turn-level ones. */
function generalFixture() {
	const general = makeProposal({ id: "gen", source_node_id: "node-summary", title: "general" });
	const specificA = makeProposal({ id: "spec-a", source_node_id: "node-turn-a", title: "specific a" });
	const specificB = makeProposal({ id: "spec-b", source_node_id: "node-turn-b", title: "specific b" });
	const supportOf: SupportMap = new Map([["gen", ["spec-a", "spec-b"]]]);
	return { general, specificA, specificB, supportOf };
}

test("nestProposals: a general proposal nests the specific proposals it generalises", () => {
	const { general, specificA, specificB, supportOf } = generalFixture();
	const tree = nestProposals([specificA, general, specificB], supportOf);
	assert.equal(tree.length, 1, "children must not appear at top level");
	assert.equal(tree[0]!.proposal.id, "gen");
	assert.deepEqual(tree[0]!.supports.map((s) => s.proposal.id), ["spec-a", "spec-b"]);
});

test("nestProposals: supports keep the caller's ranking order", () => {
	const { general } = generalFixture();
	const first = makeProposal({ id: "spec-a", source_node_id: "n1", title: "first ranked" });
	const second = makeProposal({ id: "spec-b", source_node_id: "n2", title: "second ranked" });
	const supportOf: SupportMap = new Map([["gen", ["spec-a", "spec-b"]]]);
	// Ranked order puts spec-a before spec-b even though the map lists them reversed.
	const tree = nestProposals([general, first, second], new Map([["gen", ["spec-b", "spec-a"]]]));
	assert.deepEqual(tree[0]!.supports.map((s) => s.proposal.id), ["spec-a", "spec-b"]);
});

test("nestProposals: ungrouped proposals stay roots with empty supports", () => {
	const solo = makeProposal({ id: "solo", title: "no relations" });
	const tree = nestProposals([solo], new Map());
	assert.equal(tree.length, 1);
	assert.deepEqual(tree[0]!.proposal, solo);
	assert.deepEqual(tree[0]!.supports, []);
});

// ── partial support (documented decision: nest whatever resolves; provenance, not coverage) ──

test("nestProposals: partial support nests the resolving children only", () => {
	const general = makeProposal({ id: "gen", source_node_id: "node-summary", title: "covers three turns" });
	// Only one of the consumed nodes produced a listed proposal; the other two
	// produced nothing listed (or were filtered out). The edge to "ghost" points
	// at a proposal outside the listing and must not surface.
	const child = makeProposal({ id: "child", source_node_id: "node-turn-a", title: "the one that materialised" });
	const supportOf: SupportMap = new Map([["gen", ["child", "ghost"]]]);
	const tree = nestProposals([general, child], supportOf);
	assert.equal(tree.length, 1);
	assert.deepEqual(tree[0]!.supports.map((s) => s.proposal.id), ["child"]);
});

test("nestProposals: a child whose parent is outside the listing stays a root", () => {
	// The parent proposal was filtered away (e.g. status filter): the child
	// belongs to this view even though its parent belongs to another one.
	const child = makeProposal({ id: "child", source_node_id: "node-turn-a" });
	const supportOf: SupportMap = new Map([["filtered-parent-source", ["child"]]]);
	const tree = nestProposals([child], supportOf);
	assert.equal(tree.length, 1);
	assert.equal(tree[0]!.proposal.id, "child");
	assert.deepEqual(tree[0]!.supports, []);
});

// ── multi-parent (documented decision: show under each parent — existence stays additive) ──

test("nestProposals: a child supported by two parents appears under each", () => {
	const child = makeProposal({ id: "child", source_node_id: "node-turn", title: "shared finding" });
	const parentA = makeProposal({ id: "parent-a", source_node_id: "summary-a" });
	const parentB = makeProposal({ id: "parent-b", source_node_id: "summary-b" });
	const supportOf: SupportMap = new Map([
		["parent-a", ["child"]],
		["parent-b", ["child"]],
	]);
	const tree = nestProposals([parentA, parentB, child], supportOf);
	assert.deepEqual(
		tree.map((e) => e.proposal.id),
		["parent-a", "parent-b"],
	);
	for (const entry of tree) assert.deepEqual(entry.supports.map((s) => s.proposal.id), ["child"]);
});

// ── JSON stability ──

test("serialiseGrouped: a non-grouped proposal keeps exactly its prior flat shape", () => {
	const p = makeProposal({ id: "flat", title: "flat row" });
	const json = serialiseGrouped({ proposal: p, supports: [] });
	assert.deepEqual(json, { ...p }, "must equal the spread proposal row verbatim");
	assert.ok(!("supports" in json), "no supports key on an ungrouped row");
});

test("serialiseGrouped: grouped rows embed their supports recursively", () => {
	const { general, specificA, specificB, supportOf } = generalFixture();
	const tree = nestProposals([general, specificA, specificB], supportOf);
	const json = serialiseGrouped(tree[0]!) as Record<string, unknown>;
	assert.deepEqual(json, { ...general, supports: [{ ...specificA }, { ...specificB }] });
});

test("renderGroupedProposals: nested entries render indented beneath their parent", async () => {
	const { general, specificA, specificB, supportOf } = generalFixture();
	const tree = nestProposals([general, specificA, specificB], supportOf);
	const lines = await renderGroupedProposals(tree, async (p) => p.title);
	assert.deepEqual(lines, [`${general.title}\n    ↳ ${specificA.title}\n    ↳ ${specificB.title}`]);
});

test("renderGroupedProposals: multi-line entries indent every line under the marker", async () => {
	const child = makeProposal({ id: "c", title: "c" });
	const parent = makeProposal({ id: "p", title: "p" });
	const lines = await renderGroupedProposals(
		[{ proposal: parent, supports: [{ proposal: child, supports: [] }] }],
		async (p) => `${p.title} line1\n${p.title} line2`,
	);
	assert.deepEqual(lines, ["p line1\np line2\n    ↳ c line1\n    ↳ c line2"]);
});
