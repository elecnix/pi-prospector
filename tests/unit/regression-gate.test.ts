// Tests for the gate and the verdict parser.
//
// The gate's job is recall; the parser's job is to refuse a model that contradicts
// itself. Both have cheap failure modes that are invisible on inspection — a gate
// that admits nothing looks like a quiet corpus, and a parser that repairs a
// contradiction produces a plausible row that is wrong.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_GATE_CONFIG, gateSession } from "../../src/analyze/analyzers/regression-verdict/gate.js";
import { CAUSE_CLASSES, parseVerdict } from "../../src/analyze/analyzers/regression-verdict/questions.js";
import type { MessageRow } from "../../src/analyze/analyzers/regression-signal/detect.js";

let seq = 0;
const nextId = (p: string) => `${p}-${++seq}`;

function row(role: string, text: string | null, extra: Partial<MessageRow> = {}): MessageRow {
	return {
		id: extra.id ?? nextId("m"),
		session_id: extra.session_id ?? "s1",
		role,
		content_text: text,
		content_thinking: extra.content_thinking ?? null,
		tool_calls: extra.tool_calls ?? null,
		tool_results: extra.tool_results ?? null,
		stop_reason: extra.stop_reason ?? null,
		error_message: extra.error_message ?? null,
		cost_usd: null,
	};
}

/**
 * An assistant row that ran one bash command, plus the result row that answers it.
 *
 * The shape is the one the shared action stream parses: the result row carries a
 * `tool_results` array keyed by the call's own id, and its `content_text` holds the
 * text. A row that held exactly one result lets the stream attach that text to the
 * result without splitting anything.
 */
function bash(command: string, result: string, failed = false): MessageRow[] {
	const callId = nextId("call");
	return [
		row("assistant", null, { tool_calls: JSON.stringify([{ id: callId, name: "bash", arguments: { command } }]) }),
		row("toolResult", result, {
			tool_results: JSON.stringify([{ toolCallId: callId, toolName: "bash", isError: failed, textLength: result.length }]),
		}),
	];
}

describe("gateSession", () => {
	it("admits a session that saw a failure and then repaired it", () => {
		const messages = [
			...bash("go test ./core/...", "FAIL core/schemas\npanic: nil map write", true),
			row("assistant", "That panic is a regression: the clone was removed."),
			...bash("git commit -am 'fix: restore the clone'", "[main abc1234] fix"),
		];

		const gate = gateSession(messages);

		assert.equal(gate.admit, true);
		assert.equal(gate.packet.failures.length, 1);
		assert.match(gate.packet.failures[0], /go test/);
		assert.equal(gate.packet.commits.length, 1);
		assert.ok(gate.packet.defect_statements.some((s) => /regression/.test(s)));
	});

	it("rejects a session that changed nothing", () => {
		const messages = [row("user", "What does this flag do?"), row("assistant", "It sets the timeout.")];
		const gate = gateSession(messages);

		assert.equal(gate.admit, false);
		assert.match(gate.reason, /changed nothing/);
	});

	it("rejects an additive session that saw no failure", () => {
		const messages = [
			...bash("git commit -am 'feat: add the endpoint'", "[main abc1234] feat"),
			row("assistant", "Added the endpoint and its test."),
		];

		const gate = gateSession(messages);

		assert.equal(gate.admit, false);
		assert.match(gate.reason, /named no defect/);
	});

	it("admits a revert even when nothing failed in this session", () => {
		const messages = [...bash('git revert --no-edit abc1234', '[main def5678] Revert "x"')];
		const gate = gateSession(messages);

		assert.equal(gate.admit, true);
		assert.equal(gate.packet.reverts, true);
	});

	it("bounds every evidence list so a huge session cannot blow the context", () => {
		const messages: MessageRow[] = [];
		for (let i = 0; i < 60; i++) {
			messages.push(...bash(`go test ./pkg${i}`, `FAIL pkg${i}`, true));
			messages.push(...bash(`git commit -m 'fix ${i}'`, `[main ${i}] fix`));
			messages.push(row("assistant", `That is a regression caused by the guard in file ${i}.`));
		}

		const gate = gateSession(messages);

		assert.ok(gate.packet.failures.length <= DEFAULT_GATE_CONFIG.maxFailures);
		assert.ok(gate.packet.commits.length <= DEFAULT_GATE_CONFIG.maxCommits);
		assert.ok(gate.packet.defect_statements.length <= DEFAULT_GATE_CONFIG.maxStatements);
	});

	it("pairs a failure with its own command, not with one from an earlier message", () => {
		// The first message runs a command that succeeds; the second runs one that fails.
		// Labelling the failure with the first command is the inversion this guards.
		const messages = [
			...bash("git status", "clean"),
			row("assistant", "Now the tests."),
			...bash("go test ./...", "panic: nil map", true),
		];

		const gate = gateSession(messages);

		assert.equal(gate.packet.failures.length, 1);
		assert.match(gate.packet.failures[0], /^go test/, "the failing command labels its own failure");
		assert.doesNotMatch(gate.packet.failures[0], /git status/);
	});

	it("honours statementChars, so a config change actually caps the text", () => {
		const long = "A regression caused by an earlier change, " + "with plenty more detail ".repeat(20) + ".";
		const messages = [row("assistant", long), ...bash("git commit -am 'fix: x'", "[main abc1234] fix")];

		const tight = gateSession(messages, { ...DEFAULT_GATE_CONFIG, statementChars: 40 });
		const loose = gateSession(messages, { ...DEFAULT_GATE_CONFIG, statementChars: 400 });

		const tightMax = Math.max(...tight.packet.defect_statements.map((t) => t.length));
		const looseMax = Math.max(...loose.packet.defect_statements.map((t) => t.length));
		assert.ok(tightMax <= 40, `tight cap respected, got ${tightMax}`);
		assert.ok(looseMax > tightMax, "a larger cap keeps more text");
	});

	it("records the files a session edited", () => {
		const messages = [
			row("assistant", null, {
				tool_calls: JSON.stringify([{ id: "c1", name: "edit", arguments: { path: "core/bifrost.go" } }]),
			}),
			row("toolResult", "ok"),
			row("assistant", "Fixed the panic."),
		];

		const gate = gateSession(messages);

		assert.deepEqual(gate.packet.files_touched, ["core/bifrost.go"]);
	});
});

describe("parseVerdict", () => {
	const good = {
		fixes_defect: true,
		is_regression: true,
		cause: "The clone was removed, so two goroutines shared one map.",
		cause_provenance: "inferred",
		cause_class: "shared_mutable_state",
		prevention_class: "invariant_in_types",
		prevention: "Make the context value an opaque type that cannot be mutated after it is stored.",
		blamed_pr: 612,
		confidence: 0.8,
		evidence_quote: "panic: assignment to entry in nil map",
	};

	it("reads a well-formed verdict", () => {
		const v = parseVerdict(good);

		assert.equal(v.fixes_defect, true);
		assert.equal(v.is_regression, true);
		assert.equal(v.cause_class, "shared_mutable_state");
		assert.equal(v.blamed_pr, 612);
		assert.equal(v.evidence_quote, "panic: assignment to entry in nil map");
	});

	it("refuses a regression that fixes no defect", () => {
		const v = parseVerdict({ ...good, fixes_defect: false });

		assert.equal(v.is_regression, false, "a session that fixes nothing cannot be a regression");
		assert.equal(v.cause, null);
		assert.equal(v.prevention_class, "unclassified");
	});

	it("refuses a cause class when the model admitted no cause", () => {
		const v = parseVerdict({ ...good, cause: null, cause_provenance: "unstated" });

		assert.equal(v.cause, null);
		assert.equal(v.cause_provenance, "unstated");
		assert.equal(v.cause_class, "unclassified");
	});

	it("rejects an invented cause class in favour of unclassified", () => {
		const v = parseVerdict({ ...good, cause_class: "the_model_made_this_up" });

		assert.equal(v.cause_class, "unclassified");
		assert.ok((CAUSE_CLASSES as readonly string[]).includes(v.cause_class));
	});

	it("rejects a non-integer pull request number", () => {
		assert.equal(parseVerdict({ ...good, blamed_pr: "612" }).blamed_pr, null, "a string is not a number");
		assert.equal(parseVerdict({ ...good, blamed_pr: true }).blamed_pr, null, "true is not pull request 1");
		assert.equal(parseVerdict({ ...good, blamed_pr: 61.5 }).blamed_pr, null);
		assert.equal(parseVerdict({ ...good, blamed_pr: -3 }).blamed_pr, null);
		assert.equal(parseVerdict({ ...good, blamed_pr: null }).blamed_pr, null);
	});

	it("clamps confidence into 0..1", () => {
		assert.equal(parseVerdict({ ...good, confidence: 4 }).confidence, 1);
		assert.equal(parseVerdict({ ...good, confidence: -1 }).confidence, 0);
		assert.equal(parseVerdict({ ...good, confidence: "high" }).confidence, 0);
	});

	it("treats the string 'null' as no quote", () => {
		assert.equal(parseVerdict({ ...good, evidence_quote: "null" }).evidence_quote, null);
	});

	it("drops a blamed pull request when the verdict states no cause", () => {
		// A number with no mechanism is an accusation the evidence does not carry.
		const v = parseVerdict({ ...good, cause: null, cause_provenance: "unstated", blamed_pr: 612 });

		assert.equal(v.blamed_pr, null);
		assert.equal(v.cause, null);
	});

	it("refuses a boolean confidence instead of scoring it 1", () => {
		// Number(true) is 1; a non-answer must weigh 0, not the most certain in the corpus.
		assert.equal(parseVerdict({ ...good, confidence: true }).confidence, 0);
	});

	it("drops the blame when the verdict calls its own cause unstated", () => {
		const v = parseVerdict({ ...good, cause: "a rename", cause_provenance: "unstated", blamed_pr: 412 });
		assert.equal(v.blamed_pr, null);
	});

	it("survives an empty tool response", () => {
		const v = parseVerdict({});
		assert.equal(v.fixes_defect, false);
		assert.equal(v.is_regression, false);
		assert.equal(v.confidence, 0);
	});
});
