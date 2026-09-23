import { test } from "node:test";
import assert from "node:assert/strict";
import { nestProposals, serialiseGrouped, renderGroupedProposals, type SupportMap } from "../../src/commands/grouping.js";
import type { Proposal } from "../../src/types.js";
import { makeProposal } from "./helpers.js";

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

// ── nesting edge cases (each pins one documented decision through the same pipeline) ──

type NestingTree = ReturnType<typeof nestProposals>;
type NestingCase = {
	name: string;
	listing: Proposal[];
	supportOf: SupportMap;
	check: (tree: NestingTree) => void;
};

const nestingCases: NestingCase[] = [
	{
		name: "supports keep the caller's ranking order",
		listing: [
			generalFixture().general,
			makeProposal({ id: "spec-a", source_node_id: "n1", title: "first ranked" }),
			makeProposal({ id: "spec-b", source_node_id: "n2", title: "second ranked" }),
		],
		supportOf: new Map([["gen", ["spec-b", "spec-a"]]]),
		// Ranked order puts spec-a before spec-b even though the map lists them reversed.
		check: (tree) => assert.deepEqual(tree[0]!.supports.map((s) => s.proposal.id), ["spec-a", "spec-b"]),
	},
	{
		name: "ungrouped proposals stay roots with empty supports",
		listing: [makeProposal({ id: "solo", title: "no relations" })],
		supportOf: new Map(),
		check: (tree) => {
			assert.equal(tree.length, 1);
			// makeProposal is deterministic, so this equals the listed "solo" row verbatim.
			assert.deepEqual(tree[0]!.proposal, makeProposal({ id: "solo", title: "no relations" }));
			assert.deepEqual(tree[0]!.supports, []);
		},
	},
	{
		// Documented decision: nest whatever resolves; provenance, not coverage. Only one
		// of the consumed nodes produced a listed proposal; the other two produced nothing
		// listed (or were filtered out). The edge to "ghost" points at a proposal outside
		// the listing and must not surface.
		name: "partial support nests the resolving children only",
		listing: [
			makeProposal({ id: "gen", source_node_id: "node-summary", title: "covers three turns" }),
			makeProposal({ id: "child", source_node_id: "node-turn-a", title: "the one that materialised" }),
		],
		supportOf: new Map([["gen", ["child", "ghost"]]]),
		check: (tree) => {
			assert.equal(tree.length, 1);
			assert.deepEqual(tree[0]!.supports.map((s) => s.proposal.id), ["child"]);
		},
	},
	{
		// The parent proposal was filtered away (e.g. status filter): the child belongs to
		// this view even though its parent belongs to another one.
		name: "a child whose parent is outside the listing stays a root",
		listing: [makeProposal({ id: "child", source_node_id: "node-turn-a" })],
		supportOf: new Map([["filtered-parent-source", ["child"]]]),
		check: (tree) => {
			assert.equal(tree.length, 1);
			assert.equal(tree[0]!.proposal.id, "child");
			assert.deepEqual(tree[0]!.supports, []);
		},
	},
];

for (const { name, listing, supportOf, check } of nestingCases) {
	test(`nestProposals: ${name}`, () => check(nestProposals(listing, supportOf)));
}

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
