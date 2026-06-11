import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProposalsArgs, rankProposals } from "../../src/commands/proposals.js";
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
		status: "open",
		dedup_key: "k",
		...overrides,
	};
}

test("parseProposalsArgs: empty yields no status and concise", () => {
	assert.deepEqual(parseProposalsArgs(""), { status: undefined, full: false });
	assert.deepEqual(parseProposalsArgs("   "), { status: undefined, full: false });
});

test("parseProposalsArgs: recognises a status word", () => {
	assert.deepEqual(parseProposalsArgs("applied"), { status: "applied", full: false });
	assert.deepEqual(parseProposalsArgs("OPEN"), { status: "open", full: false });
});

test("parseProposalsArgs: recognises --full / -v / --verbose in any order", () => {
	assert.deepEqual(parseProposalsArgs("--full"), { status: undefined, full: true });
	assert.deepEqual(parseProposalsArgs("-v rejected"), { status: "rejected", full: true });
	assert.deepEqual(parseProposalsArgs("duplicate --verbose"), { status: "duplicate", full: true });
});

test("parseProposalsArgs: ignores unknown tokens", () => {
	assert.deepEqual(parseProposalsArgs("garbage --nope"), { status: undefined, full: false });
});

test("rankProposals: higher confidence sorts first; nulls last", () => {
	const high = makeProposal({ id: "hi", confidence: 0.95 });
	const mid = makeProposal({ id: "mid", confidence: 0.5 });
	const none = makeProposal({ id: "none", confidence: null });
	const sorted = [none, mid, high].sort(rankProposals).map((p) => p.id);
	assert.deepEqual(sorted, ["hi", "mid", "none"]);
});

test("rankProposals: equal confidence breaks ties by newest created_at", () => {
	const older = makeProposal({ id: "old", confidence: 0.8, created_at: "2026-01-01T00:00:00.000Z" });
	const newer = makeProposal({ id: "new", confidence: 0.8, created_at: "2026-02-01T00:00:00.000Z" });
	const sorted = [older, newer].sort(rankProposals).map((p) => p.id);
	assert.deepEqual(sorted, ["new", "old"]);
});
