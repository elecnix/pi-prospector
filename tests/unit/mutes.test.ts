import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	assertionId,
	computeAssertionFingerprint,
} from "../../src/db/assertions.js";
import { parseMuteArgs, normaliseTerm } from "../../src/commands/mutes.js";

function row(subjectKind: string, subjectKey: string, verdict: string, superseded_at: string | null = null) {
	return { id: "", subject_kind: subjectKind, subject_key: subjectKey, verdict, reason: null, asserted_at: "", asserted_by: null, superseded_at };
}

describe("assertion identity", () => {
	it("is content-addressed from (subject_kind, subject_key, verdict)", () => {
		const a = assertionId("term", "wrong", "muted");
		assert.equal(a, assertionId("term", "wrong", "muted"));
		assert.notEqual(a, assertionId("term", "right", "muted"));
		assert.notEqual(a, assertionId("term", "wrong", "accepted"));
		assert.match(a, /^[0-9a-f]{16}$/);
	});

	it("fingerprint is order-independent and reflects the active set", () => {
		const r1 = [row("term", "a", "muted"), row("term", "b", "muted")];
		const r2 = [row("term", "b", "muted"), row("term", "a", "muted")];
		assert.equal(computeAssertionFingerprint(r1), computeAssertionFingerprint(r2));
		// Adding a mute changes the fingerprint (the whole point: it marks nodes stale/config).
		assert.notEqual(computeAssertionFingerprint(r1), computeAssertionFingerprint([...r1, row("term", "c", "muted")]));
		// A superseded (unmuted) row no longer counts as active.
		assert.notEqual(
			computeAssertionFingerprint(r1),
			computeAssertionFingerprint([row("term", "a", "muted", "2024-01-01T00:00:00Z"), row("term", "b", "muted")]),
		);
	});
});

describe("mute argument parsing", () => {
	it("parses term and optional reason/by", () => {
		assert.deepEqual(parseMuteArgs("wrong"), { term: "wrong", reason: null, by: null });
		assert.deepEqual(parseMuteArgs("wrong --reason because_it_is_grammar"), { term: "wrong", reason: "because_it_is_grammar", by: null });
		assert.deepEqual(parseMuteArgs("wrong --by agent"), { term: "wrong", reason: null, by: "agent" });
		assert.deepEqual(parseMuteArgs("  wrong --reason a quoted reason --by operator"), {
			term: "wrong",
			reason: "a quoted reason",
			by: "operator",
		});
		assert.deepEqual(parseMuteArgs(""), { term: undefined, reason: null, by: null });
	});

	it("normalises a term for keying", () => {
		assert.equal(normaliseTerm("Wrong"), "wrong");
		assert.equal(normaliseTerm("  PUTAIN  "), "putain");
		assert.equal(normaliseTerm(""), "");
	});
});
