/**
 * Unit tests for the time-economy analyzer's second wave of measures
 * (issue #306): background calls timed by their real completion, the exit code
 * a pipe hid, the phase spans between commits, and the spans a skill
 * occupied.
 *
 * Pure functions, no database, no mocks, no real session data — hand-written
 * synthetic rows only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TIME_ECONOMY_CONFIG } from "../../src/analyze/analyzers/time-economy/config.js";
import type { TimeEconomyConfig } from "../../src/analyze/analyzers/time-economy/config.js";
import { measureTime } from "../../src/analyze/analyzers/time-economy/detect.js";
import { findFailureMarkers } from "../../src/analyze/analyzers/time-economy/spans.js";
import { isCommitCommand, commitSubjectOf, isPreparationCommand, isFailedPreparation } from "../../src/analyze/analyzers/time-economy/spans.js";
import { measurePhaseSpans, measureSkillSpans, type SpanRow } from "../../src/analyze/analyzers/time-economy/phases.js";
import { extractBackgroundTasks, parseTaskNotification } from "../../src/sync/background-tasks.js";
import type { BackgroundTaskRow } from "../../src/analyze/types.js";
import { at, backgroundTask, result, row, shell, spanRow } from "./time-economy-fixtures.js";

const CONFIG: TimeEconomyConfig = { ...DEFAULT_TIME_ECONOMY_CONFIG };

// ─────────────────────── background-task ingestion ───────────────────────

describe("parseTaskNotification", () => {
	it("reads the tool-use id and status out of a task notification", () => {
		const content = [
			"<task-notification>",
			"<task-id>bwxhtbns4</task-id>",
			"<tool-use-id>toolu_01HejWEipWmBnseeZPxV3pAK</tool-use-id>",
			"<output-file>/tmp/tasks/bwxhtbns4.output</output-file>",
			"<status>completed</status>",
			"<summary>Background command \"build\" completed (exit code 0)</summary>",
			"</task-notification>",
		].join("\n");
		const parsed = parseTaskNotification(content);
		assert.equal(parsed?.tool_use_id, "toolu_01HejWEipWmBnseeZPxV3pAK");
		assert.equal(parsed?.task_id, "bwxhtbns4");
		assert.equal(parsed?.status, "completed");
		assert.equal(parsed?.output_file, "/tmp/tasks/bwxhtbns4.output");
	});

	it("returns null for a notification that names no tool call", () => {
		assert.equal(parseTaskNotification("<task-notification><task-id>x</task-id></task-notification>"), null);
		assert.equal(parseTaskNotification("just a prompt"), null);
		assert.equal(parseTaskNotification(null), null);
	});
});

describe("extractBackgroundTasks", () => {
	it("keeps the enqueue record that names a tool call and drops the rest", () => {
		const lines = [
			JSON.stringify({
				type: "queue-operation",
				operation: "enqueue",
				timestamp: at(120),
				content: "<task-notification>\n<tool-use-id>toolu-1</tool-use-id>\n<status>completed</status>\n</task-notification>",
			}),
			// The same notification, withdrawn: it restates the enqueue, so it
			// must not report the task twice.
			JSON.stringify({
				type: "queue-operation",
				operation: "remove",
				timestamp: at(130),
				content: "<task-notification>\n<tool-use-id>toolu-1</tool-use-id>\n<status>completed</status>\n</task-notification>",
			}),
			// An enqueue that names no tool call: a queued prompt, not a task.
			JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: at(140), content: "Commit the fonts" }),
			// A record of another kind entirely.
			JSON.stringify({ type: "assistant", uuid: "a1", message: { role: "assistant", content: [] } }),
		];
		const tasks = extractBackgroundTasks(lines, "s");
		assert.equal(tasks.length, 1);
		assert.equal(tasks[0]?.tool_use_id, "toolu-1");
		assert.equal(tasks[0]?.completed_at, at(120));
		assert.equal(tasks[0]?.status, "completed");
	});

	it("ignores a malformed line rather than failing the whole session", () => {
		const tasks = extractBackgroundTasks(["{not json", JSON.stringify({ type: "queue-operation" })], "s");
		assert.deepEqual(tasks, []);
	});
});

// ─────────────────────── background calls, timed ───────────────────────

describe("background calls", () => {
	it("times a background call by the host's completion, not by its acknowledgement", () => {
		const scan = measureTime(
			[shell("bg", "npm run build", 10), result("bg", 11)],
			CONFIG,
			[backgroundTask("bg", at(310))],
		);
		assert.equal(scan.background_calls.timed_call_count, 1);
		assert.equal(scan.background_calls.seconds, 300);
		assert.equal(scan.background_calls.calls[0]?.message_id, "call-bg");
		assert.equal(scan.background_calls.calls[0]?.status, "completed");
		// The call is not counted among the synchronous ones: it has its own span.
		assert.equal(scan.timed_call_count, 0);
		// The family carries the background work's seconds.
		assert.equal(scan.families.find((f) => f.family === "npm run")?.seconds, 300);
	});

	it("counts a background call with no completion record as untimed, never as zero", () => {
		const scan = measureTime([shell("bg", "npm run build", 10), result("bg", 11)], CONFIG, []);
		assert.equal(scan.background_calls.timed_call_count, 0);
		assert.equal(scan.background_calls.seconds, 0);
		// With no completion it is timed by its own acknowledgement, as before.
		assert.equal(scan.timed_call_count, 1);
	});

	it("counts a backgrounded call with no completion as untimed background, not by its acknowledgement", () => {
		// The call carries the host's background flag but no completion was
		// recorded. Its acknowledgement says nothing about how long the work
		// took, so it must not be timed by it.
		const scan = measureTime(
			[shell("bg", "npm run build", 10, { run_in_background: true }), result("bg", 11)],
			CONFIG,
			[],
		);
		assert.equal(scan.background_calls.timed_call_count, 0);
		assert.equal(scan.background_calls.untimed_call_count, 1);
		// Not timed at all: it is neither a timed call nor a near-instant one.
		assert.equal(scan.timed_call_count, 0);
		assert.equal(scan.untimed_call_count, 0);
		assert.equal(scan.tool_seconds, 0);
	});

	it("counts a background call whose completion carries no usable timestamp as untimed", () => {
		const scan = measureTime(
			[shell("bg", "npm run build", 10), result("bg", 11)],
			CONFIG,
			[{ ...backgroundTask("bg", "not-a-timestamp") }],
		);
		assert.equal(scan.background_calls.timed_call_count, 0);
		assert.equal(scan.background_calls.untimed_call_count, 1);
	});

	it("counts a failed background task in its family's error count", () => {
		const scan = measureTime(
			[shell("bg", "npm run build", 10), result("bg", 11)],
			CONFIG,
			[backgroundTask("bg", at(310), "failed")],
		);
		const family = scan.families.find((f) => f.family === "npm run");
		assert.equal(family?.error_count, 1, "the host's verdict counts as the family's error");
	});

	it("does not count a completed background task as an error", () => {
		const scan = measureTime(
			[shell("bg", "npm run build", 10), result("bg", 11)],
			CONFIG,
			[backgroundTask("bg", at(310), "completed")],
		);
		const family = scan.families.find((f) => f.family === "npm run");
		assert.equal(family?.error_count, 0);
	});
});

// ─────────────────────── the exit code a pipe hid ───────────────────────

describe("findFailureMarkers", () => {
	it("recognises a test runner's own way of saying it failed", () => {
		assert.deepEqual(findFailureMarkers("--- FAIL: test_thing (0.01s)", CONFIG.failureMarkers), ["^--- (FAIL|ERROR):"]);
		assert.deepEqual(findFailureMarkers("2 failed, 40 passed", CONFIG.failureMarkers), ["\\b[1-9][0-9]* failed\\b.*\\b(passed|passing|total)\\b"]);
		assert.deepEqual(findFailureMarkers("FAIL src/thing.test.ts", CONFIG.failureMarkers), ["^(FAIL|FAILED)\\b"]);
	});

	it("leaves ordinary output alone", () => {
		assert.deepEqual(findFailureMarkers("40 passed, 0 failed", CONFIG.failureMarkers), []);
		assert.deepEqual(findFailureMarkers("build ok", CONFIG.failureMarkers), []);
	});

	it("does not fire on a document that merely quotes a failure phrase", () => {
		// A grep over the source, or a file that documents the error, names the
		// phrase without the run having failed.
		assert.deepEqual(findFailureMarkers("src/auth.ts:42: // handle Permission denied", CONFIG.failureMarkers), []);
		assert.deepEqual(findFailureMarkers("grep -rn FAILED src/", CONFIG.failureMarkers), []);
		assert.deepEqual(findFailureMarkers("the build will fail if the token expired", CONFIG.failureMarkers), []);
		assert.deepEqual(
			findFailureMarkers('The message "command not found is what bash prints" is in the docs.', CONFIG.failureMarkers),
			[],
		);
	});

	it("does not fire on a grep hit that names an exception class or an error code", () => {
		// The class name and the diagnostic code appear in the source, so a
		// grep over it prints them without anything having failed.
		assert.deepEqual(findFailureMarkers("src/a.test.ts:12: ...toThrow(AssertionError)", CONFIG.failureMarkers), []);
		assert.deepEqual(findFailureMarkers("src/x.ts:1: // error TS1234", CONFIG.failureMarkers), []);
		assert.deepEqual(findFailureMarkers("src/x.py:3: # Traceback (most recent call last)", CONFIG.failureMarkers), []);
	});

	it("recognises the shape a runner or a compiler prints", () => {
		assert.deepEqual(findFailureMarkers("E       AssertionError: boom", CONFIG.failureMarkers), ["^E\\s+AssertionError\\b"]);
		assert.deepEqual(findFailureMarkers("AssertionError: boom", CONFIG.failureMarkers), ["^AssertionError\\b"]);
		assert.deepEqual(
			findFailureMarkers("src/x.ts(3,5): error TS2322: Type mismatch", CONFIG.failureMarkers),
			["^\\S+\\.\\w+\\(\\d+,\\d+\\): error TS[0-9]+\\b"],
		);
	});

	it("does not fire on a grep hit that prints the shell's own diagnostic shape", () => {
		// The shape the shell prints is "prog: operand: message". A grep hit
		// that happens to contain that text is still the grep's output, and
		// the grep succeeded — but the shell's prefix is what a real failure
		// carries, and a grep over source rarely reproduces it verbatim.
		assert.deepEqual(findFailureMarkers("src/auth.ts:42: // handle Permission denied", CONFIG.failureMarkers), []);
	});

	it("recognises the shell's own diagnostic shape", () => {
		assert.deepEqual(findFailureMarkers("cat: notes.txt: Permission denied", CONFIG.failureMarkers), ["^\\S+: \\S+: Permission denied$"]);
		assert.deepEqual(findFailureMarkers("bash: foo: command not found", CONFIG.failureMarkers), ["^\\S+: \\S+: command not found$"]);
	});

	it("reports one failure once, whichever way round the markers are tried", () => {
		// `--- FAIL:` and `\\bFAIL\\b` match the same failure. The catalogue's
		// order must not decide whether it is reported once or twice.
		const forward = findFailureMarkers("--- FAIL: test_x", CONFIG.failureMarkers);
		const reversed = findFailureMarkers("--- FAIL: test_x", [...CONFIG.failureMarkers].reverse());
		assert.equal(forward.length, 1);
		assert.equal(reversed.length, 1);
		assert.deepEqual(forward, reversed, "the same markers, the same single finding");
	});

	it("still reports two genuinely different failures", () => {
		const found = findFailureMarkers("--- FAIL: test_x\ncat: notes.txt: Permission denied", CONFIG.failureMarkers);
		assert.equal(found.length, 2);
	});
});

describe("hidden exit codes", () => {
	it("reports a successful call whose output shows a failure", () => {
		const scan = measureTime(
			[shell("t", "npm test 2>&1 | tail -40", 0), result("t", 60, false, "--- FAIL: test_x (0.02s)\n1 failed, 12 passed")],
			CONFIG,
		);
		assert.equal(scan.hidden_exit_codes.length, 1);
		assert.equal(scan.hidden_exit_codes[0]?.message_id, "call-t");
		assert.equal(scan.hidden_exit_codes[0]?.family, "npm test");
		assert.ok(scan.hidden_exit_codes[0]?.markers.includes("^--- (FAIL|ERROR):"));
	});

	it("leaves a call the harness already flagged as an error to the failure analysis", () => {
		const scan = measureTime(
			[shell("t", "npm test", 0), result("t", 60, true, "--- FAIL: test_x")],
			CONFIG,
		);
		assert.equal(scan.hidden_exit_codes.length, 0);
	});

	it("does not read a non-shell call's output as a hidden failure", () => {
		// A file that documents the error is not a failed command, and a
		// non-shell tool has no exit code for a pipe to hide.
		const scan = measureTime(
			[
				row({
					id: "call-r",
					role: "assistant",
					timestamp: at(0),
					tool_calls: JSON.stringify([{ id: "r", name: "read", arguments: { file_path: "src/auth.ts" } }]),
				}),
				row({
					id: "res-r",
					role: "toolResult",
					timestamp: at(1),
					content_text: "// handle Permission denied here",
					tool_results: JSON.stringify([{ toolCallId: "r", toolName: "read", isError: false, textLength: 30 }]),
				}),
			],
			CONFIG,
		);
		assert.equal(scan.hidden_exit_codes.length, 0);
	});
});

// ─────────────────────── phase spans ───────────────────────

describe("commit detection", () => {
	it("recognises a commit and reads its subject", () => {
		assert.equal(isCommitCommand("git commit -m 'fix the parser'"), true);
		assert.equal(isCommitCommand("git commit -m 'fix the parser' --amend"), true);
		assert.equal(isCommitCommand("git log --oneline"), false);
		assert.equal(isCommitCommand("git show HEAD"), false);
		assert.equal(commitSubjectOf("git commit -m 'fix the parser'"), "fix the parser");
		assert.equal(commitSubjectOf("git commit"), null);
	});

	it("recognises the commands that start a commit's preparation", () => {
		assert.equal(isPreparationCommand("npm test"), true);
		assert.equal(isPreparationCommand("git add -A"), true);
		assert.equal(isPreparationCommand("gh pr view 12"), true);
		assert.equal(isPreparationCommand("cat file.txt"), false);
	});
});

describe("measurePhaseSpans", () => {
	it("measures the span from the session's start to its first commit", () => {
		const rows = [
			spanRow({ id: "u1", role: "user", timestamp: at(0) }),
			spanRow({ id: "c1", role: "assistant", timestamp: at(60), tool_calls: JSON.stringify([{ id: "t1", name: "bash", arguments: { command: "npm test" } }]) }),
			spanRow({ id: "r1", role: "toolResult", timestamp: at(120) }),
			spanRow({ id: "c2", role: "assistant", timestamp: at(180), tool_calls: JSON.stringify([{ id: "t2", name: "bash", arguments: { command: "git commit -m 'first'" } }]) }),
			spanRow({ id: "r2", role: "toolResult", timestamp: at(185) }),
		];
		const spans = measurePhaseSpans(rows, { isCommit: isCommitCommand, isPreparation: isPreparationCommand, commitSubject: commitSubjectOf });
		const first = spans.find((s) => s.kind === "start_to_first_commit");
		assert.ok(first);
		assert.equal(first.end_reason, "commit");
		assert.equal(first.commit_subject, "first");
		assert.equal(first.seconds, 180);
		assert.equal(first.turns, 1);
	});

	it("measures each commit's preparation from the first test run after the previous commit", () => {
		const rows = [
			spanRow({ id: "u1", role: "user", timestamp: at(0) }),
			spanRow({ id: "c1", role: "assistant", timestamp: at(10), tool_calls: JSON.stringify([{ id: "t1", name: "bash", arguments: { command: "npm test" } }]) }),
			spanRow({ id: "r1", role: "toolResult", timestamp: at(100) }),
			spanRow({ id: "c2", role: "assistant", timestamp: at(110), tool_calls: JSON.stringify([{ id: "t2", name: "bash", arguments: { command: "git commit -m 'one'" } }]) }),
			spanRow({ id: "r2", role: "toolResult", timestamp: at(120) }),
			spanRow({ id: "c3", role: "assistant", timestamp: at(200), tool_calls: JSON.stringify([{ id: "t3", name: "bash", arguments: { command: "npm test" } }]) }),
			spanRow({ id: "r3", role: "toolResult", timestamp: at(400) }),
			spanRow({ id: "c4", role: "assistant", timestamp: at(500), tool_calls: JSON.stringify([{ id: "t4", name: "bash", arguments: { command: "git commit -m 'two'" } }]) }),
			spanRow({ id: "r4", role: "toolResult", timestamp: at(510) }),
		];
		const spans = measurePhaseSpans(rows, { isCommit: isCommitCommand, isPreparation: isPreparationCommand, commitSubject: commitSubjectOf });
		const preparations = spans.filter((s) => s.kind === "commit_preparation");
		assert.equal(preparations.length, 2);
		// The first commit's preparation starts at the first test run, at 10.
		assert.equal(preparations[0]?.seconds, 100);
		assert.equal(preparations[0]?.commit_subject, "one");
		// The second commit's preparation starts at the test run after the first
		// commit, at 200 — not at the first test run of the session.
		assert.equal(preparations[1]?.seconds, 300);
		assert.equal(preparations[1]?.commit_subject, "two");
	});

	it("does not start a preparation at a test run that failed", () => {
		const rows = [
			spanRow({ id: "u1", role: "user", timestamp: at(0) }),
			// A test run the host reported as an error: it left work to do, so
			// it did not prepare the commit.
			spanRow({ id: "c1", role: "assistant", timestamp: at(10), tool_calls: JSON.stringify([{ id: "t1", name: "bash", arguments: { command: "npm test" } }]) }),
			spanRow({ id: "r1", role: "toolResult", timestamp: at(100), tool_results: JSON.stringify([{ toolCallId: "t1", toolName: "bash", isError: true, textLength: 20 }]) }),
			// The passing run that did prepare it.
			spanRow({ id: "c2", role: "assistant", timestamp: at(200), tool_calls: JSON.stringify([{ id: "t2", name: "bash", arguments: { command: "npm test" } }]) }),
			spanRow({ id: "r2", role: "toolResult", timestamp: at(300) }),
			spanRow({ id: "c3", role: "assistant", timestamp: at(400), tool_calls: JSON.stringify([{ id: "t3", name: "bash", arguments: { command: "git commit -m 'one'" } }]) }),
		];
		const spans = measurePhaseSpans(rows, {
			isCommit: isCommitCommand,
			isPreparation: isPreparationCommand,
			commitSubject: commitSubjectOf,
			isFailedPreparation,
			failureMarkers: CONFIG.failureMarkers,
		});
		const preparation = spans.find((s) => s.kind === "commit_preparation");
		assert.ok(preparation);
		// The preparation starts at the passing run, at 200.
		assert.equal(preparation.start_message_id, "c2");
		assert.equal(preparation.seconds, 200);
	});

	it("does not start a preparation at a test run whose failure a pipe hid", () => {
		const rows = [
			spanRow({ id: "u1", role: "user", timestamp: at(0) }),
			// The host reports this run as a success; only its output says it
			// failed.
			spanRow({ id: "c1", role: "assistant", timestamp: at(10), tool_calls: JSON.stringify([{ id: "t1", name: "bash", arguments: { command: "npm test 2>&1 | tail -40" } }]) }),
			spanRow({ id: "r1", role: "toolResult", timestamp: at(100), content_text: "--- FAIL: test_x (0.02s)\n1 failed, 12 passed", tool_results: JSON.stringify([{ toolCallId: "t1", toolName: "bash", isError: false, textLength: 40 }]) }),
			spanRow({ id: "c2", role: "assistant", timestamp: at(200), tool_calls: JSON.stringify([{ id: "t2", name: "bash", arguments: { command: "npm test" } }]) }),
			spanRow({ id: "r2", role: "toolResult", timestamp: at(300) }),
			spanRow({ id: "c3", role: "assistant", timestamp: at(400), tool_calls: JSON.stringify([{ id: "t3", name: "bash", arguments: { command: "git commit -m 'one'" } }]) }),
		];
		const spans = measurePhaseSpans(rows, {
			isCommit: isCommitCommand,
			isPreparation: isPreparationCommand,
			commitSubject: commitSubjectOf,
			isFailedPreparation,
			failureMarkers: CONFIG.failureMarkers,
		});
		const preparation = spans.find((s) => s.kind === "commit_preparation");
		assert.ok(preparation);
		assert.equal(preparation.start_message_id, "c2");
		assert.equal(preparation.seconds, 200);
	});

	it("does not claim a preparation marker for a commit with no usable timestamp", () => {
		const rows = [
			spanRow({ id: "u1", role: "user", timestamp: at(0) }),
			// The commit carries no timestamp, so it cannot bound a preparation.
			spanRow({ id: "c1", role: "assistant", timestamp: null, tool_calls: JSON.stringify([{ id: "t1", name: "bash", arguments: { command: "git commit -m 'one'" } }]) }),
			// A marker from a later turn, which must not be claimed as its start.
			spanRow({ id: "c2", role: "assistant", timestamp: at(300), tool_calls: JSON.stringify([{ id: "t2", name: "bash", arguments: { command: "git add -A" } }]) }),
		];
		const spans = measurePhaseSpans(rows, { isCommit: isCommitCommand, isPreparation: isPreparationCommand, commitSubject: commitSubjectOf });
		const preparation = spans.find((s) => s.kind === "commit_preparation");
		assert.ok(preparation);
		// No marker is claimed, so the span starts at the session's start.
		assert.equal(preparation.start_message_id, "u1");
		assert.equal(preparation.seconds, 0);
	});

	it("says so when the session never reached a commit", () => {
		const rows = [
			spanRow({ id: "u1", role: "user", timestamp: at(0) }),
			spanRow({ id: "c1", role: "assistant", timestamp: at(60) }),
		];
		const spans = measurePhaseSpans(rows, { isCommit: isCommitCommand, isPreparation: isPreparationCommand });
		assert.equal(spans[0]?.end_reason, "session_end");
		assert.equal(spans[0]?.seconds, 60);
	});

	it("measures a commit with no preparation marker from the previous commit, not from zero", () => {
		const rows = [
			spanRow({ id: "u1", role: "user", timestamp: at(0) }),
			spanRow({ id: "c1", role: "assistant", timestamp: at(100), tool_calls: JSON.stringify([{ id: "t1", name: "bash", arguments: { command: "git commit -m 'one'" } }]) }),
			spanRow({ id: "r1", role: "toolResult", timestamp: at(110) }),
			// No test run, no git add, no review between the two commits.
			spanRow({ id: "c2", role: "assistant", timestamp: at(300), tool_calls: JSON.stringify([{ id: "t2", name: "bash", arguments: { command: "git commit -m 'two'" } }]) }),
			spanRow({ id: "r2", role: "toolResult", timestamp: at(310) }),
		];
		const spans = measurePhaseSpans(rows, { isCommit: isCommitCommand, isPreparation: isPreparationCommand, commitSubject: commitSubjectOf });
		const preparations = spans.filter((s) => s.kind === "commit_preparation");
		assert.equal(preparations.length, 2);
		// The first commit's preparation starts at the session's start.
		assert.equal(preparations[0]?.seconds, 100);
		// The second commit's preparation starts at the previous commit, so the
		// span measures the work between them rather than reporting zero.
		assert.equal(preparations[1]?.seconds, 200);
		assert.equal(preparations[1]?.start_message_id, "c1");
	});

	it("reports tokens as unknown when the transcript recorded none", () => {
		const rows = [
			spanRow({ id: "u1", role: "user", timestamp: at(0) }),
			spanRow({ id: "c1", role: "assistant", timestamp: at(60), usage: JSON.stringify({ input: 10, output: 5, totalTokens: 15 }) }),
			spanRow({ id: "c2", role: "assistant", timestamp: at(180), tool_calls: JSON.stringify([{ id: "t2", name: "bash", arguments: { command: "git commit" } }]) }),
		];
		const spans = measurePhaseSpans(rows, { isCommit: isCommitCommand, isPreparation: isPreparationCommand });
		assert.equal(spans[0]?.tokens, 15);
	});
});

// ─────────────────────── skill spans ───────────────────────

describe("measureSkillSpans", () => {
	it("ends a skill span at the next skill call in the same turn", () => {
		const rows = [
			spanRow({ id: "u1", role: "user", timestamp: at(0) }),
			spanRow({ id: "s1", role: "assistant", timestamp: at(10), tool_calls: JSON.stringify([{ id: "sk1", name: "Skill", arguments: { skill: "review" } }]) }),
			spanRow({ id: "s2", role: "assistant", timestamp: at(70), tool_calls: JSON.stringify([{ id: "sk2", name: "Skill", arguments: { skill: "pr" } }]) }),
			spanRow({ id: "r2", role: "toolResult", timestamp: at(90) }),
		];
		const spans = measureSkillSpans(rows, { isError: () => false });
		assert.equal(spans.length, 2);
		assert.equal(spans[0]?.skill, "review");
		assert.equal(spans[0]?.seconds, 60);
		assert.equal(spans[0]?.end_reason, "next_skill");
		// The second skill runs to the end of its turn.
		assert.equal(spans[1]?.skill, "pr");
		assert.equal(spans[1]?.end_reason, "turn_end");
	});

	it("ends a pull-request skill at its successful gh pr create", () => {
		const rows = [
			spanRow({ id: "u1", role: "user", timestamp: at(0) }),
			spanRow({ id: "s1", role: "assistant", timestamp: at(10), tool_calls: JSON.stringify([{ id: "sk1", name: "Skill", arguments: { skill: "pr" } }]) }),
			spanRow({ id: "c1", role: "assistant", timestamp: at(100), tool_calls: JSON.stringify([{ id: "gh1", name: "bash", arguments: { command: "gh pr create --title x" } }]) }),
			spanRow({ id: "r1", role: "toolResult", timestamp: at(110), tool_results: JSON.stringify([{ toolCallId: "gh1", toolName: "bash", isError: false, textLength: 20 }]) }),
			spanRow({ id: "u2", role: "user", timestamp: at(500) }),
		];
		const spans = measureSkillSpans(rows);
		assert.equal(spans.length, 1);
		assert.equal(spans[0]?.end_reason, "pr_created");
		// The span ends when the forge answered, not when the call was issued.
		assert.equal(spans[0]?.seconds, 100);
	});

	it("does not end a pull-request skill at a failed gh pr create", () => {
		const rows = [
			spanRow({ id: "u1", role: "user", timestamp: at(0) }),
			spanRow({ id: "s1", role: "assistant", timestamp: at(10), tool_calls: JSON.stringify([{ id: "sk1", name: "Skill", arguments: { skill: "pr" } }]) }),
			spanRow({ id: "c1", role: "assistant", timestamp: at(100), tool_calls: JSON.stringify([{ id: "gh1", name: "bash", arguments: { command: "gh pr create" } }]) }),
			spanRow({ id: "r1", role: "toolResult", timestamp: at(110), tool_results: JSON.stringify([{ toolCallId: "gh1", toolName: "bash", isError: true, textLength: 20 }]) }),
			spanRow({ id: "u2", role: "user", timestamp: at(500) }),
		];
		const spans = measureSkillSpans(rows);
		assert.equal(spans[0]?.end_reason, "turn_end");
	});

	it("does not end a non-pull-request skill at an unrelated gh pr create", () => {
		const rows = [
			spanRow({ id: "u1", role: "user", timestamp: at(0) }),
			spanRow({ id: "s1", role: "assistant", timestamp: at(10), tool_calls: JSON.stringify([{ id: "sk1", name: "Skill", arguments: { skill: "code-review" } }]) }),
			// A pull request created later, by other work.
			spanRow({ id: "c1", role: "assistant", timestamp: at(300), tool_calls: JSON.stringify([{ id: "gh1", name: "bash", arguments: { command: "gh pr create" } }]) }),
			spanRow({ id: "r1", role: "toolResult", timestamp: at(310), tool_results: JSON.stringify([{ toolCallId: "gh1", toolName: "bash", isError: false, textLength: 20 }]) }),
			spanRow({ id: "u2", role: "user", timestamp: at(500) }),
		];
		const spans = measureSkillSpans(rows);
		assert.equal(spans.length, 1);
		assert.equal(spans[0]?.skill, "code-review");
		// The review skill ends at its turn, not at the later PR.
		assert.equal(spans[0]?.end_reason, "turn_end");
		assert.equal(spans[0]?.seconds, 300);
	});

	it("does not claim a gh pr create for a skill with no usable timestamp", () => {
		const rows = [
			spanRow({ id: "u1", role: "user", timestamp: at(0) }),
			// The skill call carries no timestamp, so its span has no lower
			// bound and cannot claim any creation.
			spanRow({ id: "s1", role: "assistant", timestamp: null, tool_calls: JSON.stringify([{ id: "sk1", name: "Skill", arguments: { skill: "pr" } }]) }),
			spanRow({ id: "c1", role: "assistant", timestamp: at(100), tool_calls: JSON.stringify([{ id: "gh1", name: "bash", arguments: { command: "gh pr create" } }]) }),
			spanRow({ id: "r1", role: "toolResult", timestamp: at(110), tool_results: JSON.stringify([{ toolCallId: "gh1", toolName: "bash", isError: false, textLength: 20 }]) }),
		];
		const spans = measureSkillSpans(rows);
		assert.equal(spans.length, 1);
		assert.notEqual(spans[0]?.end_reason, "pr_created");
	});

	it("ends a skill span at the end of the turn it ran in, in any turn", () => {
		// The skill is in the second turn, so the turn it belongs to is not
		// the first: a lookup that keyed the turn's end by anything but the
		// turn's own ordinal would miss it and stretch the span to the
		// session's end.
		const rows = [
			spanRow({ id: "u1", role: "user", timestamp: at(0) }),
			spanRow({ id: "a1", role: "assistant", timestamp: at(10) }),
			spanRow({ id: "u2", role: "user", timestamp: at(100) }),
			spanRow({ id: "s1", role: "assistant", timestamp: at(110), tool_calls: JSON.stringify([{ id: "sk1", name: "Skill", arguments: { skill: "review" } }]) }),
			spanRow({ id: "r1", role: "toolResult", timestamp: at(180) }),
			spanRow({ id: "a2", role: "assistant", timestamp: at(200) }),
			spanRow({ id: "u3", role: "user", timestamp: at(900) }),
		];
		const spans = measureSkillSpans(rows);
		assert.equal(spans.length, 1);
		assert.equal(spans[0]?.end_reason, "turn_end");
		// The turn ended at 200, not at the session's end.
		assert.equal(spans[0]?.seconds, 90);
	});

	it("does not end a pull-request skill at a gh pr create whose answer lands after the next skill", () => {
		// The span ends when the forge answered, and the answer came after the
		// next skill started. Claiming it would make the two spans overlap.
		const rows = [
			spanRow({ id: "u1", role: "user", timestamp: at(0) }),
			spanRow({ id: "s1", role: "assistant", timestamp: at(100), tool_calls: JSON.stringify([{ id: "sk1", name: "Skill", arguments: { skill: "pr" } }]) }),
			spanRow({ id: "c1", role: "assistant", timestamp: at(150), tool_calls: JSON.stringify([{ id: "gh1", name: "bash", arguments: { command: "gh pr create" } }]) }),
			// The next skill starts at 160, before the answer arrives at 500.
			spanRow({ id: "s2", role: "assistant", timestamp: at(160), tool_calls: JSON.stringify([{ id: "sk2", name: "Skill", arguments: { skill: "review" } }]) }),
			spanRow({ id: "r1", role: "toolResult", timestamp: at(500), tool_results: JSON.stringify([{ toolCallId: "gh1", toolName: "bash", isError: false, textLength: 20 }]) }),
		];
		const spans = measureSkillSpans(rows);
		assert.equal(spans.length, 2);
		// The PR skill does not claim the late answer; it ends at the next skill.
		assert.equal(spans[0]?.end_reason, "next_skill");
		assert.equal(spans[0]?.seconds, 60);
	});

	it("does not double-count a nested skill", () => {
		const rows = [
			spanRow({ id: "u1", role: "user", timestamp: at(0) }),
			spanRow({ id: "s1", role: "assistant", timestamp: at(10), tool_calls: JSON.stringify([{ id: "sk1", name: "Skill", arguments: { skill: "outer" } }]) }),
			spanRow({ id: "s2", role: "assistant", timestamp: at(70), tool_calls: JSON.stringify([{ id: "sk2", name: "Skill", arguments: { skill: "inner" } }]) }),
			spanRow({ id: "r2", role: "toolResult", timestamp: at(90) }),
			spanRow({ id: "u2", role: "user", timestamp: at(500) }),
		];
		const spans = measureSkillSpans(rows);
		// Two spans, and they abut rather than overlap.
		assert.equal(spans.length, 2);
		assert.equal(spans[0]?.seconds, 60);
		assert.equal(spans[1]?.end_reason, "turn_end");
	});
});
