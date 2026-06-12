import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProposalsArgs, rankProposals, sessionLabel, statusLabel } from "../../src/commands/proposals.js";
import type { Proposal } from "../../src/types.js";
import { homedir } from "node:os";

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
		input_key: "k",
		source_message_ids: null,
		validated_score: null,
		validation_status: "unvalidated",
		validation_node_id: null,
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

test("rankProposals: supported > unvalidated > unsupported, regardless of model confidence", () => {
	// The dogfood case: the unsupported proposal has the *highest* model
	// confidence (0.95) yet must sink below an untested one and far below a
	// replay-supported one.
	const supported = makeProposal({ id: "sup", validation_status: "supported", validated_score: 1, confidence: 0.3 });
	const unvalidated = makeProposal({ id: "unv", validation_status: "unvalidated", confidence: 0.5 });
	const unsupported = makeProposal({ id: "uns", validation_status: "unsupported", validated_score: 0, confidence: 0.95 });
	const sorted = [unsupported, unvalidated, supported].sort(rankProposals).map((p) => p.id);
	assert.deepEqual(sorted, ["sup", "unv", "uns"]);
});

test("rankProposals: supported proposals order by validated score", () => {
	const hi = makeProposal({ id: "hi", validation_status: "supported", validated_score: 1 });
	const lo = makeProposal({ id: "lo", validation_status: "supported", validated_score: 0.5 });
	const sorted = [lo, hi].sort(rankProposals).map((p) => p.id);
	assert.deepEqual(sorted, ["hi", "lo"]);
});

test("statusLabel: replay-validated shows outcome and score; unvalidated falls back to model confidence", () => {
	assert.equal(statusLabel(makeProposal({ validation_status: "supported", validated_score: 1 })), "replay-validated:supported 100%");
	assert.equal(statusLabel(makeProposal({ validation_status: "unsupported", validated_score: 0 })), "replay-validated:unsupported 0%");
	assert.equal(statusLabel(makeProposal({ validation_status: "unvalidated", confidence: 0.7 })), "model-rated 70%");
	assert.equal(statusLabel(makeProposal({ validation_status: "unvalidated", confidence: null })), "model-rated n/a");
});

test("sessionLabel: prefers cwd with $HOME collapsed to ~", () => {
	const cwd = `${homedir()}/Source/pi-prospector/main`;
	assert.equal(sessionLabel({ project: "proj", cwd }, "abcdef12"), "~/Source/pi-prospector/main");
});

test("sessionLabel: falls back to project then short id", () => {
	assert.equal(sessionLabel({ project: "proj", cwd: "" }, "abcdef1234"), "proj");
	assert.equal(sessionLabel(undefined, "abcdef1234"), "abcdef12");
	assert.equal(sessionLabel({ project: "", cwd: "" }, "abcdef1234"), "abcdef12");
});
