/**
 * Unit tests for the time-economy analyzer's deterministic timing (issue #306).
 * Pure functions, no database, no mocks, no real session data — hand-written
 * synthetic rows only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TIME_ECONOMY_CONFIG } from "../../src/analyze/analyzers/time-economy/config.js";
import type { TimeEconomyConfig } from "../../src/analyze/analyzers/time-economy/config.js";
import {
	classifyWait,
	commandFamily,
	measureTime,
	type TimeScan,
} from "../../src/analyze/analyzers/time-economy/detect.js";
import { buildProposals } from "../../src/analyze/analyzers/time-economy/index.js";
import type { MessageRow } from "../../src/analyze/types.js";

const CONFIG: TimeEconomyConfig = { ...DEFAULT_TIME_ECONOMY_CONFIG };

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
/** An ISO timestamp `s` seconds after the fixture's start. */
function at(s: number): string {
	return new Date(T0 + s * 1000).toISOString();
}

let seq = 0;
function row(partial: Partial<MessageRow> & { role: string }): MessageRow {
	const id = partial.id ?? `row-${seq++}`;
	return {
		id,
		session_id: "s",
		parent_id: null,
		timestamp: null,
		content_text: null,
		content_thinking: null,
		tool_calls: null,
		tool_results: null,
		model: null,
		cost_usd: null,
		stop_reason: null,
		error_message: null,
		...partial,
	};
}

/** An assistant row issuing one shell call at second `s`. */
function shell(id: string, command: string, s: number | null): MessageRow {
	return row({
		id: `call-${id}`,
		role: "assistant",
		timestamp: s === null ? null : at(s),
		tool_calls: JSON.stringify([{ id, name: "bash", arguments: { command } }]),
	});
}

/** The tool-result row answering call `id` at second `s`. */
function result(id: string, s: number | null, isError = false, text: string | null = null): MessageRow {
	return row({
		id: `res-${id}`,
		role: "toolResult",
		timestamp: s === null ? null : at(s),
		content_text: text,
		tool_results: JSON.stringify([{ toolCallId: id, toolName: "bash", isError, textLength: text?.length ?? 10 }]),
	});
}

// ─────────────────────────── command families ───────────────────────────

describe("commandFamily", () => {
	it("keeps the leading command words", () => {
		assert.equal(commandFamily("npm test -- --grep foo", 2), "npm test");
		assert.equal(commandFamily("pytest -x tests/unit", 2), "pytest -x");
	});

	it("drops a leading cd, environment assignments, and a timeout wrapper", () => {
		assert.equal(commandFamily("cd /repo/sub && npm test", 2), "npm test");
		assert.equal(commandFamily("cd /repo; FOO=1 BAR=x npm run build", 2), "npm run");
		assert.equal(commandFamily("timeout 590 ./scripts/check.sh --all", 2), "./scripts/check.sh --all");
	});

	it("reduces a multi-line command to its first line", () => {
		assert.equal(commandFamily("git status\ngit diff", 2), "git status");
	});

	it("names an empty command honestly", () => {
		assert.equal(commandFamily("   ", 2), "(empty)");
	});
});

// ─────────────────────────── waits inside a call ───────────────────────────

describe("classifyWait", () => {
	it("recognises a loop that sleeps as a wait", () => {
		assert.equal(classifyWait("until [ -s out.log ]; do sleep 5; done", CONFIG).inCallWait, true);
		assert.equal(classifyWait("for i in $(seq 1 60); do curl -s localhost:8080 && break; sleep 10; done", CONFIG).inCallWait, true);
		assert.equal(classifyWait("while true; do check || break; sleep 30; done", CONFIG).inCallWait, true);
	});

	it("recognises a long standalone sleep and a blocking watcher", () => {
		assert.equal(classifyWait("sleep 120 && cat out.log", CONFIG).inCallWait, true);
		assert.equal(classifyWait("gh run watch 12345 --exit-status", CONFIG).inCallWait, true);
	});

	it("leaves ordinary commands and short pauses alone", () => {
		assert.equal(classifyWait("npm test", CONFIG).inCallWait, false);
		assert.equal(classifyWait("sleep 1; git status", CONFIG).inCallWait, false);
		assert.equal(classifyWait("for f in *.ts; do wc -l $f; done", CONFIG).inCallWait, false);
	});

	it("flags a pgrep -f loop, which matches its own command line", () => {
		const w = classifyWait("until ! pgrep -f run-smoke; do sleep 5; done; echo done", CONFIG);
		assert.equal(w.inCallWait, true);
		assert.equal(w.selfMatching, true);
		assert.equal(classifyWait("while ps aux | grep smoke-runner >/dev/null; do sleep 5; done", CONFIG).selfMatching, true);
	});

	it("does not flag loops that cannot match themselves", () => {
		assert.equal(classifyWait("until ! pgrep -f '[r]un-smoke'; do sleep 5; done", CONFIG).selfMatching, false);
		assert.equal(classifyWait("while ps aux | grep smoke | grep -v grep >/dev/null; do sleep 5; done", CONFIG).selfMatching, false);
		assert.equal(classifyWait("while kill -0 $PID 2>/dev/null; do sleep 5; done", CONFIG).selfMatching, false);
		assert.equal(classifyWait("until ! pgrep -x node; do sleep 5; done", CONFIG).selfMatching, false);
		assert.equal(classifyWait("pgrep -f run-smoke", CONFIG).selfMatching, false);
	});

	it("flags a loop that breaks out on pgrep -f inside its body", () => {
		const w = classifyWait("for i in $(seq 1 50); do pgrep -f run-gates >/dev/null || break; sleep 10; done", CONFIG);
		assert.equal(w.selfMatching, true);
	});

	it("does not flag a loop that iterates over pgrep output", () => {
		const w = classifyWait("pgrep -f start.py | while read p; do lsof -p $p -d cwd; done", CONFIG);
		assert.equal(w.selfMatching, false);
		assert.equal(w.inCallWait, false);
	});

	it("ignores loops written into a heredoc rather than run", () => {
		const w = classifyWait(
			"cat > load.sh <<'SH'\nuntil ! pgrep -f worker; do sleep 5; done\nSH\nchmod +x load.sh",
			CONFIG,
		);
		assert.equal(w.selfMatching, false);
		assert.equal(w.inCallWait, false);
	});
});

// ─────────────────────────── measuring a session ───────────────────────────

describe("measureTime", () => {
	it("times each call from the issuing message to its result", () => {
		const scan = measureTime(
			[
				row({ role: "user", content_text: "run the tests", timestamp: at(0) }),
				shell("a", "npm test", 10),
				result("a", 70),
				shell("b", "npm test", 80),
				result("b", 200, true),
				shell("c", "git status", 210),
				result("c", 211),
			],
			CONFIG,
		);
		assert.equal(scan.timed_call_count, 3);
		assert.equal(scan.untimed_call_count, 0);
		assert.equal(scan.tool_seconds, 181);
		const npm = scan.families.find((f) => f.family === "npm test");
		assert.deepEqual(npm, { family: "npm test", calls: 2, seconds: 180, max_seconds: 120, error_count: 1 });
		// Families are ranked by total seconds.
		assert.equal(scan.families[0]!.family, "npm test");
	});

	it("counts a call it cannot time as untimed, never as zero seconds", () => {
		const scan = measureTime(
			[
				shell("a", "npm test", null),
				result("a", 30),
				shell("b", "npm test", 40),
				// b never got a result: an abandoned call.
				shell("c", "git log", 50),
				result("c", 45), // result stamped before its call: clock skew, not a duration
			],
			CONFIG,
		);
		assert.equal(scan.timed_call_count, 0);
		assert.equal(scan.untimed_call_count, 3);
		assert.equal(scan.tool_seconds, 0);
	});

	it("caps idle gaps between messages but keeps a long call's own time active", () => {
		const scan = measureTime(
			[
				row({ role: "user", content_text: "go", timestamp: at(0) }),
				shell("a", "./build.sh", 10),
				result("a", 1210), // a 20-minute call: active, not idle
				row({ role: "assistant", content_text: "built", timestamp: at(1220) }),
				row({ role: "user", content_text: "next", timestamp: at(5000) }), // a 63-minute pause: idle
			],
			CONFIG,
		);
		assert.equal(scan.wall_clock_seconds, 5000);
		assert.equal(scan.active_seconds, 10 + 1200 + 10 + CONFIG.idleCapSeconds);
	});

	it("totals waits inside calls and lists self-matching loops", () => {
		const scan = measureTime(
			[
				shell("a", "until [ -s out.log ]; do sleep 5; done", 0),
				result("a", 300),
				shell("b", "until ! pgrep -f run-smoke; do sleep 5; done", 310),
				result("b", 910),
				shell("c", "npm test", 920),
				result("c", 980),
			],
			CONFIG,
		);
		assert.equal(scan.in_call_waits.call_count, 2);
		assert.equal(scan.in_call_waits.seconds, 900);
		assert.equal(scan.in_call_waits.longest_seconds, 600);
		assert.deepEqual(scan.self_matching_waits, [{ message_id: "call-b", seconds: 600, family: "until !", ran_to_limit: false }]);
	});

	it("confirms a self-matching loop that the harness timed out", () => {
		const scan = measureTime(
			[
				shell("b", "until ! pgrep -f run-smoke; do sleep 5; done", 0),
				result("b", 600, false, "Command did not complete within its 600s timeout and was moved to the background (ID: x)."),
			],
			CONFIG,
		);
		assert.equal(scan.self_matching_waits[0]!.ran_to_limit, true);
		assert.equal(scan.timed_out_calls.call_count, 1);
		assert.equal(scan.timed_out_calls.seconds, 600);
	});

	it("does not read a timeout phrase inside a command's own output as a harness timeout", () => {
		const scan = measureTime(
			[
				shell("l", "grep -n timeout app.log", 0),
				result("l", 1, false, "12: request timed out after 30s\n40: Command did not complete within its 600s timeout"),
			],
			CONFIG,
		);
		assert.equal(scan.timed_out_calls.call_count, 0);
	});

	it("confirms a bounded self-matching loop that ran to its own bound", () => {
		const scan = measureTime(
			[
				shell("f", "for i in $(seq 1 30); do pgrep -f runner >/dev/null || break; sleep 10; done", 0),
				result("f", 295),
				shell("g", "for i in $(seq 1 30); do pgrep -f runner >/dev/null || break; sleep 10; done", 300),
				result("g", 340), // broke out early: pgrep stopped matching, so it was not matching itself
			],
			CONFIG,
		);
		assert.deepEqual(
			scan.self_matching_waits.map((w) => w.ran_to_limit),
			[true, false],
		);
	});

	it("measures a session with no tool calls without inventing any", () => {
		const scan = measureTime(
			[
				row({ role: "user", content_text: "hi", timestamp: at(0) }),
				row({ role: "assistant", content_text: "hello", timestamp: at(3) }),
			],
			CONFIG,
		);
		assert.equal(scan.timed_call_count, 0);
		assert.equal(scan.families.length, 0);
		assert.equal(scan.active_seconds, 3);
	});
});

// ─────────────────────────── proposals ───────────────────────────

function scanWith(partial: Partial<TimeScan>): TimeScan {
	return {
		timed_call_count: 10,
		untimed_call_count: 0,
		tool_seconds: 0,
		wall_clock_seconds: 3600,
		active_seconds: 3000,
		families: [],
		in_call_waits: { call_count: 0, seconds: 0, longest_seconds: 0, message_ids: [] },
		self_matching_waits: [],
		timed_out_calls: { call_count: 0, seconds: 0, message_ids: [] },
		...partial,
	};
}

describe("buildProposals", () => {
	it("proposes nothing for a session that waited little", () => {
		const proposals = buildProposals(
			scanWith({ in_call_waits: { call_count: 2, seconds: 120, longest_seconds: 90, message_ids: ["m1", "m2"] } }),
			CONFIG,
		);
		assert.deepEqual(proposals, []);
	});

	it("proposes a standing-instruction change once in-call waits pass the threshold", () => {
		const proposals = buildProposals(
			scanWith({ in_call_waits: { call_count: 4, seconds: 1500, longest_seconds: 900, message_ids: ["m1"] } }),
			CONFIG,
		);
		assert.equal(proposals.length, 1);
		const p = proposals[0]!;
		assert.equal(p.target_type, "agents_md");
		assert.equal(p.severity, "waste");
		assert.match(p.title, /4 tool calls waited 25 min/);
		assert.match(p.summary, /50% of the session's 50 active minutes/);
	});

	it("proposes running long commands in the background once calls keep hitting the tool timeout", () => {
		const two = buildProposals(scanWith({ timed_out_calls: { call_count: 2, seconds: 240, message_ids: ["a", "b"] } }), CONFIG);
		assert.deepEqual(two, [], "below the call threshold, nothing is proposed");
		const proposals = buildProposals(
			scanWith({ timed_out_calls: { call_count: 3, seconds: 1320, message_ids: ["a", "b", "c"] } }),
			CONFIG,
		);
		assert.equal(proposals.length, 1);
		assert.match(proposals[0]!.title, /3 tool calls ran until the harness timed them out/);
		assert.match(proposals[0]!.summary, /22 min/);
	});

	it("proposes a fix for a self-matching wait loop that ran past its threshold", () => {
		const proposals = buildProposals(
			scanWith({
				in_call_waits: { call_count: 1, seconds: 600, longest_seconds: 600, message_ids: ["m9"] },
				self_matching_waits: [
					{ message_id: "m9", seconds: 600, family: "until !", ran_to_limit: true },
					{ message_id: "m10", seconds: 20, family: "until !", ran_to_limit: true },
					{ message_id: "m11", seconds: 300, family: "until !", ran_to_limit: false },
				],
			}),
			CONFIG,
		);
		const p = proposals.find((x) => x.title.includes("matched its own command line"));
		assert.ok(p, "a self-matching proposal is emitted");
		assert.match(p!.title, /1 wait loop matched its own command line/);
		assert.match(p!.detail, /pgrep -f/);
	});
});
