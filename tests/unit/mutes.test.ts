import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	assertionId,
	computeAssertionFingerprint,
} from "../../src/db/assertions.js";
import { parseMuteArgs, parseUnmuteArgs, normaliseTerm } from "../../src/commands/mutes.js";

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
	});

	it("fingerprint distinguishes an active mute from a superseded one", () => {
		// An unmute must be its own recipe. If the superseded state hashed the same
		// as the active one, unmuting would restore the fingerprint of the state
		// *before* the mute — a recipe whose node the mute's own revision had
		// already replaced — and the framework would classify it `current` and skip
		// the recomputation, leaving the muted version as the answer.
		const active = [row("term", "a", "muted")];
		const superseded = [row("term", "a", "muted", "2024-01-01T00:00:00Z")];
		assert.notEqual(computeAssertionFingerprint(active), computeAssertionFingerprint(superseded));
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

	it("reads a quoted term without its quote marks", () => {
		assert.deepEqual(parseMuteArgs('"do"'), { term: "do", reason: null, by: null });
		assert.deepEqual(parseMuteArgs("'never' --by agent"), { term: "never", reason: null, by: "agent" });
	});

	it("reads a quoted multi-word term whole", () => {
		assert.deepEqual(parseMuteArgs('"do not" --reason an instruction word'), {
			term: "do not",
			reason: "an instruction word",
			by: null,
		});
	});

	it("reads an unquoted multi-word term up to the first flag", () => {
		assert.deepEqual(parseMuteArgs("you need --by operator"), { term: "you need", reason: null, by: "operator" });
	});

	it("leaves the term empty for an unterminated quote", () => {
		assert.deepEqual(parseMuteArgs('"do not --reason x'), { term: undefined, reason: null, by: null });
	});

	it("parses unmute arguments the same way", () => {
		assert.equal(parseUnmuteArgs('"do not"'), "do not");
		assert.equal(parseUnmuteArgs("never"), "never");
		assert.equal(parseUnmuteArgs(""), undefined);
	});

	it("normalises a term for keying", () => {
		assert.equal(normaliseTerm('"Do Not"'), "do not");
		assert.equal(normaliseTerm("  do   not "), "do not");
		assert.equal(normaliseTerm("Wrong"), "wrong");
		assert.equal(normaliseTerm("  PUTAIN  "), "putain");
		assert.equal(normaliseTerm(""), "");
	});

	it("leaves an empty term empty, so the caller can refuse it", () => {
		// A term of only quote marks, or only whitespace, is no term at all. The
		// command must refuse it rather than record an assertion with an empty key.
		assert.equal(parseMuteArgs('""').term, undefined);
		assert.equal(parseMuteArgs("''").term, undefined);
		assert.equal(parseMuteArgs("   ").term, undefined);
		assert.equal(parseUnmuteArgs('""'), undefined);
		assert.equal(normaliseTerm('""'), "");
		assert.equal(normaliseTerm("   "), "");
	});
});
