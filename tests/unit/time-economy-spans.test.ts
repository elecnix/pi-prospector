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
import { findFailureMarkers, type PhaseSpan } from "../../src/analyze/analyzers/time-economy/spans.js";
import { isCommitCommand, commitSubjectOf, isPreparationCommand, isFailedPreparation, isPullRequestSkill, isPrCreateCommand } from "../../src/analyze/analyzers/time-economy/spans.js";
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

	it("finds a hidden failure in a backgrounded call's output too", () => {
		// The same call can be a slow background task and hide a failure. The
		// background path is a separate branch of the timing pass, and it
		// must not skip the output check.
		const scan = measureTime(
			[
				shell("bg", "npm test 2>&1 | tail -40", 10, { run_in_background: true }),
				result("bg", 11, false, "--- FAIL: test_x (0.02s)\n1 failed, 12 passed"),
			],
			CONFIG,
			[backgroundTask("bg", at(310))],
		);
		assert.equal(scan.hidden_exit_codes.length, 1);
		assert.equal(scan.hidden_exit_codes[0]?.message_id, "call-bg");
		assert.equal(scan.hidden_exit_codes[0]?.family, "npm test");
		// The call's real end is known, so its duration is too.
		assert.equal(scan.hidden_exit_codes[0]?.seconds, 300);
	});

	it("reports a backgrounded hidden failure whose duration is unknown", () => {
		// The completion was never recorded, so the duration is unknown. The
		// failure is still worth reporting, and the duration says so rather
		// than reading as zero.
		const scan = measureTime(
			[
				shell("bg", "npm test 2>&1 | tail -40", 10, { run_in_background: true }),
				result("bg", 11, false, "--- FAIL: test_x (0.02s)\n1 failed, 12 passed"),
			],
			CONFIG,
			[],
		);
		assert.equal(scan.hidden_exit_codes.length, 1);
		assert.equal(scan.hidden_exit_codes[0]?.seconds, null);
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

	it("does not mistake a command that only mentions a commit for one", () => {
		// The agent quoting a commit command is not committing: the phase span
		// would end at the quote instead of at the real commit.
		assert.equal(isCommitCommand("echo 'git commit -m \"x\"'"), false);
		// A different git command that shares the name writes a commit object
		// without landing the work on a branch.
		assert.equal(isCommitCommand("git commit-tree abc123"), false);
	});

	it("does not mistake a heredoc body for a commit", () => {
		// The agent writing a script that contains a commit command is not
		// committing either. A heredoc body is text, not a command.
		const script = "cat > /tmp/deploy.sh <<'EOF'\ngit commit -m 'phantom'\nEOF";
		assert.equal(isCommitCommand(script), false);
	});

	it("recognises a commit behind git's global options", () => {
		// `git -C <dir>` is how an agent commits in a worktree, and
		// `--git-dir=` names the repository outright. Both are still commits.
		assert.equal(isCommitCommand("git -C /repo commit -m 'fix'"), true);
		assert.equal(isCommitCommand("git --git-dir=/repo/.git commit -m 'fix'"), true);
		assert.equal(isCommitCommand("git -c user.name=dev commit -m 'fix'"), true);
		assert.equal(isPreparationCommand("git -C /repo add -A"), true);
		// A long option that takes its value separately is not a global
		// option, so the word after it is not a subcommand.
		assert.equal(isCommitCommand("git log --grep commit"), false);
	});

	it("reads each command a chained command runs", () => {
		// A shell runs the parts of a chained command in turn, and each is a
		// command of its own.
		assert.equal(isCommitCommand("git add -A && git commit -m 'x'"), true);
		assert.equal(isPreparationCommand("git add -A && git commit -m 'x'"), true);
		assert.equal(isCommitCommand("git add -A; git commit -m 'x'"), true);
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

	/**
	 * A session whose first test run failed, followed by a passing one and a
	 * commit. The failed run is described by `firstRun`, so each caller can
	 * show the failure it is about and the shared shape stays in one place.
	 */
	function failedThenPassingRun(firstRun: {
		command: string;
		isError: boolean;
		output?: string;
	}): SpanRow[] {
		return [
			spanRow({ id: "u1", role: "user", timestamp: at(0) }),
			spanRow({ id: "c1", role: "assistant", timestamp: at(10), tool_calls: JSON.stringify([{ id: "t1", name: "bash", arguments: { command: firstRun.command } }]) }),
			spanRow({
				id: "r1",
				role: "toolResult",
				timestamp: at(100),
				content_text: firstRun.output ?? null,
				tool_results: JSON.stringify([{ toolCallId: "t1", toolName: "bash", isError: firstRun.isError, textLength: (firstRun.output ?? "").length || 20 }]),
			}),
			// The passing run that did prepare the commit.
			spanRow({ id: "c2", role: "assistant", timestamp: at(200), tool_calls: JSON.stringify([{ id: "t2", name: "bash", arguments: { command: "npm test" } }]) }),
			spanRow({ id: "r2", role: "toolResult", timestamp: at(300) }),
			spanRow({ id: "c3", role: "assistant", timestamp: at(400), tool_calls: JSON.stringify([{ id: "t3", name: "bash", arguments: { command: "git commit -m 'one'" } }]) }),
		];
	}

	it("counts every turn the span reaches into", () => {
		// The span starts in the first turn, at 150, and ends in the next, at
		// 250. The first turn closed at 200, before the span ended, so the
		// first clause cannot match it — and the second clause cannot either,
		// because the turn opened before the span started. The span still
		// covered that turn's work, so both turns count.
		const rows = [
			spanRow({ id: "u1", role: "user", timestamp: at(0) }),
			spanRow({ id: "c1", role: "assistant", timestamp: at(150), tool_calls: JSON.stringify([{ id: "t1", name: "bash", arguments: { command: "npm test" } }]) }),
			spanRow({ id: "r1", role: "toolResult", timestamp: at(200) }),
			spanRow({ id: "u2", role: "user", timestamp: at(220) }),
			spanRow({ id: "c2", role: "assistant", timestamp: at(250), tool_calls: JSON.stringify([{ id: "t2", name: "bash", arguments: { command: "git commit -m 'x'" } }]) }),
		];
		const spans = measurePhaseSpans(rows, { isCommit: isCommitCommand, isPreparation: isPreparationCommand, commitSubject: commitSubjectOf });
		const preparation = spans.find((s) => s.kind === "commit_preparation");
		assert.ok(preparation);
		assert.equal(preparation.turns, 2);
	});

	it("does not start a preparation at a test run that failed", () => {
		// The host reported the run as an error: it left work to do, so it did
		// not prepare the commit.
		const rows = failedThenPassingRun({ command: "npm test", isError: true });
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
		// The turn the preparation opened in is counted, even though the turn
		// itself opened before the preparation's start.
		assert.equal(preparation.turns, 1);
	});

	it("does not start a preparation at a test run whose failure a pipe hid", () => {
		// The host reports this run as a success; only its output says it
		// failed.
		const rows = failedThenPassingRun({
			command: "npm test 2>&1 | tail -40",
			isError: false,
			output: "--- FAIL: test_x (0.02s)\n1 failed, 12 passed",
		});
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

	it("does not start a preparation at a commit that stages and commits at once", () => {
		// `git add -A && git commit` is both a preparation command and the
		// commit, so it cannot be its own preparation start.
		const rows = [
			spanRow({ id: "u1", role: "user", timestamp: at(0) }),
			spanRow({ id: "c1", role: "assistant", timestamp: at(100), tool_calls: JSON.stringify([{ id: "t1", name: "bash", arguments: { command: "git add -A && git commit -m 'one'" } }]) }),
			spanRow({ id: "r1", role: "toolResult", timestamp: at(110) }),
		];
		const spans = measurePhaseSpans(rows, { isCommit: isCommitCommand, isPreparation: isPreparationCommand, commitSubject: commitSubjectOf });
		const preparation = spans.find((s) => s.kind === "commit_preparation");
		assert.ok(preparation);
		// No separate preparation was seen, so the span starts at the
		// session's start rather than reporting zero.
		assert.equal(preparation.start_message_id, "u1");
		assert.equal(preparation.seconds, 100);
	});

	it("keeps the last placed commit as the next commit's lower bound", () => {
		// The first commit carries no timestamp, so it cannot bound the
		// second commit's preparation. The bound stays at the last *placed*
		// commit, so a preparation from before the unplaceable one is not
		// admitted as the second's start.
		const rows = [
			spanRow({ id: "u1", role: "user", timestamp: at(0) }),
			// A preparation before the first commit.
			spanRow({ id: "c0", role: "assistant", timestamp: at(20), tool_calls: JSON.stringify([{ id: "t0", name: "bash", arguments: { command: "npm test" } }]) }),
			// A commit with no timestamp.
			spanRow({ id: "c1", role: "assistant", timestamp: null, tool_calls: JSON.stringify([{ id: "t1", name: "bash", arguments: { command: "git commit -m 'one'" } }]) }),
			// A preparation after it, and the next commit.
			spanRow({ id: "c2", role: "assistant", timestamp: at(300), tool_calls: JSON.stringify([{ id: "t2", name: "bash", arguments: { command: "npm test" } }]) }),
			spanRow({ id: "r2", role: "toolResult", timestamp: at(320) }),
			spanRow({ id: "c3", role: "assistant", timestamp: at(400), tool_calls: JSON.stringify([{ id: "t3", name: "bash", arguments: { command: "git commit -m 'two'" } }]) }),
		];
		const spans = measurePhaseSpans(rows, { isCommit: isCommitCommand, isPreparation: isPreparationCommand, commitSubject: commitSubjectOf });
		const preparations = spans.filter((s) => s.kind === "commit_preparation");
		// The second commit's preparation is measured from the run at 300,
		// and does not reach back across the commit that had no timestamp.
		const second = preparations.find((s) => s.commit_subject === "two");
		assert.ok(second);
		assert.equal(second.start_message_id, "c2");
		assert.equal(second.seconds, 100);
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

	it("measures a session whose rows are out of timestamp order", () => {
		// Rows are not guaranteed to be in timestamp order, so the session's
		// bounds are its earliest and its latest, not its first and its last
		// row. A session whose last row is earlier than its first is still a
		// session of a real length.
		const rows = [
			spanRow({ id: "u1", role: "user", timestamp: at(500) }),
			spanRow({ id: "c1", role: "assistant", timestamp: at(100) }),
			spanRow({ id: "r1", role: "toolResult", timestamp: at(200) }),
		];
		const spans = measurePhaseSpans(rows, { isCommit: isCommitCommand, isPreparation: isPreparationCommand });
		assert.equal(spans[0]?.end_reason, "session_end");
		// From the earliest row at 100 to the latest at 500.
		assert.equal(spans[0]?.seconds, 400);
		// The message ids name the rows that carry those bounds, so the id and
		// the time agree.
		assert.equal(spans[0]?.start_message_id, "c1");
		assert.equal(spans[0]?.end_message_id, "u1");
	});

	it("counts the turn a preparation opened in, even when the turn began earlier", () => {
		// The turn opened at 0, the preparation at 10 and the commit at 110.
		// The span covers the one turn the preparation belonged to: a turn
		// counts when the span reaches into it, not only when the span opened
		// at the turn's own start.
		const rows = [
			spanRow({ id: "u1", role: "user", timestamp: at(0) }),
			spanRow({ id: "c1", role: "assistant", timestamp: at(10), tool_calls: JSON.stringify([{ id: "t1", name: "bash", arguments: { command: "npm test" } }]) }),
			spanRow({ id: "r1", role: "toolResult", timestamp: at(100) }),
			spanRow({ id: "c2", role: "assistant", timestamp: at(110), tool_calls: JSON.stringify([{ id: "t2", name: "bash", arguments: { command: "git commit -m 'one'" } }]) }),
			spanRow({ id: "r2", role: "toolResult", timestamp: at(120) }),
		];
		const spans = measurePhaseSpans(rows, { isCommit: isCommitCommand, isPreparation: isPreparationCommand, commitSubject: commitSubjectOf });
		const preparation = spans.find((s) => s.kind === "commit_preparation");
		assert.ok(preparation);
		assert.equal(preparation.turns, 1);
	});

	it("does not end a start-to-first-commit span at a command that only mentions a commit", () => {
		// The agent writes a script whose body contains a commit command. The
		// span must end at the real commit, not at the quote.
		const rows = [
			spanRow({ id: "u1", role: "user", timestamp: at(0) }),
			spanRow({
				id: "c0",
				role: "assistant",
				timestamp: at(10),
				tool_calls: JSON.stringify([{ id: "t0", name: "bash", arguments: { command: "cat > /tmp/deploy.sh <<'EOF'\ngit commit -m 'phantom'\nEOF" } }]),
			}),
			spanRow({ id: "r0", role: "toolResult", timestamp: at(20) }),
			spanRow({ id: "c1", role: "assistant", timestamp: at(300), tool_calls: JSON.stringify([{ id: "t1", name: "bash", arguments: { command: "git commit -m 'real'" } }]) }),
			spanRow({ id: "r1", role: "toolResult", timestamp: at(310) }),
		];
		const spans = measurePhaseSpans(rows, { isCommit: isCommitCommand, isPreparation: isPreparationCommand, commitSubject: commitSubjectOf });
		const start = spans.find((s) => s.kind === "start_to_first_commit");
		assert.ok(start);
		assert.equal(start.commit_subject, "real");
		assert.equal(start.end_message_id, "c1");
		assert.equal(start.seconds, 300);
		// One commit, not two: the quote did not open a preparation span.
		assert.equal(spans.filter((s) => s.kind === "commit_preparation").length, 1);
	});

	/**
	 * A session whose only preparation marker is a skill call.
	 *
	 * The two tests below differ only in the skill's name, so the shared
	 * shape moves into a helper and each test stands on its own.
	 */
	function sessionWithSkill(skill: string): SpanRow[] {
		return [
			spanRow({ id: "u1", role: "user", timestamp: at(0) }),
			spanRow({ id: "s1", role: "assistant", timestamp: at(10), tool_calls: JSON.stringify([{ id: "sk1", name: "Skill", arguments: { skill } }]) }),
			spanRow({ id: "r1", role: "toolResult", timestamp: at(20) }),
			spanRow({ id: "c1", role: "assistant", timestamp: at(100), tool_calls: JSON.stringify([{ id: "t1", name: "bash", arguments: { command: "git commit -m 'x'" } }]) }),
		];
	}

	/** The preparation span of a session whose only marker is a skill. */
	function preparationOf(skill: string): PhaseSpan | undefined {
		const spans = measurePhaseSpans(sessionWithSkill(skill), {
			isCommit: isCommitCommand,
			isPreparation: isPreparationCommand,
			commitSubject: commitSubjectOf,
			isPreparationSkill: isPullRequestSkill,
		});
		return spans.find((s) => s.kind === "commit_preparation");
	}

	it("starts a preparation at a pull-request skill", () => {
		// The issue names four preparation markers: a full test run, `git add`,
		// a review, and a PR skill. The skill is a tool call, not a shell
		// command, so the preparation scan has to see it too.
		const preparation = preparationOf("pr");
		assert.ok(preparation);
		assert.equal(preparation.start_message_id, "s1");
		assert.equal(preparation.seconds, 90);
	});

	it("does not start a preparation at a skill that opens no pull request", () => {
		const preparation = preparationOf("code-review");
		assert.ok(preparation);
		// No marker was seen, so the span starts at the session's start.
		assert.equal(preparation.start_message_id, "u1");
		assert.equal(preparation.seconds, 100);
	});

	it("does not read a shell command that mentions a skill as a preparation", () => {
		// The skill is a tool call. A command that merely names one — the
		// agent reading the skill's own documentation, say — is not it.
		assert.equal(isPreparationCommand("cat skills/pr.md"), false);
		assert.equal(isPreparationCommand("echo 'use the skill for pr'"), false);
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

	it("does not end a pull-request skill at a command that only mentions a creation", () => {
		// The agent echoes the command it is about to run, or writes it into
		// a script. Neither creates a pull request, so neither ends the span.
		assert.equal(isPrCreateCommand("echo 'gh pr create'"), false);
		assert.equal(isPrCreateCommand("cat > /tmp/open.sh <<'EOF'\ngh pr create --title x\nEOF"), false);
		assert.equal(isPrCreateCommand("gh pr create --title x"), true);
	});

	it("does not end a pull-request skill at a later turn's gh pr create", () => {
		// The skill's turn ended at 150. A creation in the next turn, at 5000,
		// is not the skill's work: the turn closed, and whatever came after
		// belongs to a later turn. The span ends at the turn, not at the
		// creation.
		const rows = [
			spanRow({ id: "u1", role: "user", timestamp: at(0) }),
			spanRow({ id: "s1", role: "assistant", timestamp: at(100), tool_calls: JSON.stringify([{ id: "sk1", name: "Skill", arguments: { skill: "pr" } }]) }),
			spanRow({ id: "r1", role: "toolResult", timestamp: at(150) }),
			spanRow({ id: "u2", role: "user", timestamp: at(5000) }),
			spanRow({ id: "c1", role: "assistant", timestamp: at(5000), tool_calls: JSON.stringify([{ id: "gh1", name: "bash", arguments: { command: "gh pr create" } }]) }),
			spanRow({ id: "r2", role: "toolResult", timestamp: at(5010), tool_results: JSON.stringify([{ toolCallId: "gh1", toolName: "bash", isError: false, textLength: 20 }]) }),
		];
		const spans = measureSkillSpans(rows);
		assert.equal(spans.length, 1);
		assert.equal(spans[0]?.end_reason, "turn_end");
		assert.equal(spans[0]?.seconds, 50);
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
		// The review skill ends at its turn, not at the later PR. The turn
		// runs to the last message before the next user turn — the PR's
		// result at 310 — so the span is 300 seconds.
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

	it("ends a skill in the harness's opening turn at that turn's end", () => {
		// A skill the harness invoked before any user message. The opening
		// turn ends at the first user message, so the span must not stretch
		// past it.
		const rows = [
			spanRow({ id: "s0", role: "assistant", timestamp: at(0), tool_calls: JSON.stringify([{ id: "sk0", name: "Skill", arguments: { skill: "review" } }]) }),
			spanRow({ id: "r0", role: "toolResult", timestamp: at(30) }),
			spanRow({ id: "u1", role: "user", timestamp: at(100) }),
		];
		const spans = measureSkillSpans(rows);
		assert.equal(spans.length, 1);
		assert.equal(spans[0]?.end_reason, "turn_end");
		assert.equal(spans[0]?.seconds, 30);
	});

	it("does not end a skill span at the turn after the one it ran in", () => {
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
		// The turn the skill ran in is counted, even though the turn opened
		// before the skill's own start.
		assert.equal(spans[0]?.turns, 1);
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

	it("ends a skill at the session's latest message, not at its last row", () => {
		// Rows are not guaranteed to be in timestamp order, so the session's
		// end is its latest message. A skill whose turn cannot be placed ends
		// at that message, not at whichever row happens to be last.
		const rows = [
			spanRow({ id: "s1", role: "assistant", timestamp: at(100), tool_calls: JSON.stringify([{ id: "sk1", name: "Skill", arguments: { skill: "review" } }]) }),
			spanRow({ id: "r1", role: "toolResult", timestamp: at(200) }),
			spanRow({ id: "u1", role: "user", timestamp: at(50) }),
		];
		const spans = measureSkillSpans(rows);
		assert.equal(spans.length, 1);
		// The opening turn runs to the latest message, at 200, and the last
		// row is the user message at 50.
		assert.equal(spans[0]?.end_reason, "turn_end");
		assert.equal(spans[0]?.seconds, 100);
	});
});
