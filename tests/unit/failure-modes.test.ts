/**
 * Unit tests for the failure-mode catalogue, the shared action stream, and the
 * proposal rules built on top of them.
 *
 * All fixtures are hand-written synthetic data — no real session content. The
 * error strings below are shape-accurate but carry no account, org, or request
 * identifiers.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	classifyFailure,
	curatedPackages,
	failureClass,
	TURN_FAILURE_CLASSES,
	TOOL_FAILURE_CLASSES,
} from "../../src/analyze/analyzers/failure-modes/classes.js";
import {
	buildProposals,
	groupFailures,
	normalizeForFingerprint,
	unclassifiedCount,
} from "../../src/analyze/analyzers/failure-modes/detect.js";
import { DEFAULT_FAILURE_MODES_CONFIG } from "../../src/analyze/analyzers/failure-modes/config.js";
import {
	normalizePackageSpec,
	readInstalledPackages,
} from "../../src/analyze/analyzers/failure-modes/installed.js";
import { buildToolStream } from "../../src/analyze/tool-stream.js";
import type { MessageRow } from "../../src/analyze/types.js";
import { makeMessageRow } from "./helpers.js";

// ──────────────────── helpers ────────────────────

const msg = makeMessageRow;

function assistantFailure(id: string, error: string, costUsd: number | null = null): MessageRow {
	return msg({ id, role: "assistant", stop_reason: "error", error_message: error, cost_usd: costUsd });
}

function callAndResult(
	callId: string,
	tool: string,
	args: Record<string, unknown>,
	result?: { isError: boolean; text?: string },
): MessageRow[] {
	const rows: MessageRow[] = [
		msg({
			id: `a-${callId}`,
			role: "assistant",
			stop_reason: "toolUse",
			tool_calls: JSON.stringify([{ id: callId, name: tool, arguments: args }]),
		}),
	];
	if (result) {
		rows.push(
			msg({
				id: `r-${callId}`,
				role: "toolResult",
				content_text: result.text ?? null,
				tool_results: JSON.stringify([
					{ toolCallId: callId, toolName: tool, isError: result.isError, textLength: (result.text ?? "").length },
				]),
			}),
		);
	}
	return rows;
}

const NO_INSTALLS = { names: new Set<string>(), known: true };

/**
 * One failed bash call per command: an assistant tool-call row paired with its
 * error-flagged result row. Fixture for grouping/proposal tests.
 */
function failedBashCalls(commands: string[]): MessageRow[] {
	const rows: MessageRow[] = [];
	for (const cmd of commands) {
		const id = `c${rows.length / 2}`;
		rows.push(
			msg({ id: `a-${id}`, role: "assistant", tool_calls: JSON.stringify([{ id, name: "bash", arguments: { command: cmd } }]) }),
			msg({
				id: `r-${id}`,
				role: "toolResult",
				content_text: "",
				tool_results: JSON.stringify([{ toolCallId: id, toolName: "bash", isError: true, textLength: 0 }]),
			}),
		);
	}
	return rows;
}

// ──────────────────── the catalogue ────────────────────

describe("classifyFailure", () => {
	it("names the rate-limit class from a provider 429", () => {
		const c = classifyFailure('429: {"type":"api_error","message":"rate limit exceeded"}', "turn");
		assert.equal(c.classId, "rate-limit");
	});

	it("names the rate-limit class from an account usage-limit message with no status code", () => {
		const c = classifyFailure("you (…) have reached your weekly usage limit", "turn");
		assert.equal(c.classId, "rate-limit");
	});

	it("separates a dropped stream from a provider 5xx", () => {
		assert.equal(classifyFailure("Error reading stream: stream closed", "turn").classId, "provider-transport");
		assert.equal(classifyFailure("500: Internal Server Error", "turn").classId, "provider-server");
	});

	it("names the malformed-tool-call class from a JSON parse error", () => {
		assert.equal(classifyFailure("Unexpected token < in JSON at position 3", "turn").classId, "malformed-tool-call");
		assert.equal(classifyFailure("Unterminated string in JSON", "turn").classId, "malformed-tool-call");
	});

	it("reads a prompt-token ceiling as a context ceiling, not as a billing problem", () => {
		// The host wraps this one in a 402, which would otherwise read as "out of
		// credit". The fix is compaction, not money, so message text wins over code.
		const c = classifyFailure('402: {"code":"402","message":"Prompt tokens limit exceeded: 300000"}', "turn");
		assert.equal(c.classId, "context-overflow");
	});

	it("classifies an abort, and marks it as nothing to act on", () => {
		const c = classifyFailure("This operation was aborted", "turn");
		assert.equal(c.classId, "aborted");
		assert.equal(failureClass("aborted")!.actionable, false);
	});

	it("returns unclassified rather than forcing a poor fit", () => {
		assert.equal(classifyFailure("something entirely novel happened", "turn").classId, "unclassified");
		assert.equal(classifyFailure("", "turn").classId, "unclassified");
	});

	// The classes below were added because a run over a real day of sessions left
	// 65% of tool failures unnamed. Each one is a shape that actually occurred.
	it("names an edit whose anchor did not match the file", () => {
		assert.equal(classifyFailure("Could not find the exact text to replace", "tool").classId, "edit-anchor-miss");
		assert.equal(classifyFailure("Could not find edits[2] in /tmp/x.ts", "tool").classId, "edit-anchor-miss");
		assert.equal(classifyFailure("Found 3 occurrences of the text; the anchor must be unique", "tool").classId, "edit-anchor-miss");
	});

	it("recommends no package for an anchor miss, which no repair layer can fix", () => {
		// A repair layer fixes malformed arguments; it cannot know what the file says.
		assert.deepEqual(failureClass("edit-anchor-miss")!.extensions, []);
	});

	it("names a script the agent wrote that was itself broken", () => {
		assert.equal(classifyFailure("Traceback (most recent call last):\n  File \"x.py\"", "tool").classId, "script-error");
		assert.equal(classifyFailure("bash: -c: line 4: unexpected EOF while looking for matching `\"'", "tool").classId, "script-error");
		assert.equal(classifyFailure("ModuleNotFoundError: no module named 'x'", "tool").classId, "script-error");
	});

	it("names an action a guardrail refused", () => {
		assert.equal(classifyFailure("Blocked: sleep 30. A fixed sleep is not allowed", "tool").classId, "policy-blocked");
		assert.equal(classifyFailure("User declined to provide the token", "tool").classId, "policy-blocked");
	});

	it("separates a third-party API's rate limit from the model provider's", () => {
		// No LLM retry extension touches a GitHub rate limit, so the remedy differs.
		assert.equal(classifyFailure("GraphQL: API rate limit already exceeded", "tool").classId, "remote-rate-limit");
		assert.deepEqual(failureClass("remote-rate-limit")!.extensions, []);
	});

	it("names a tool whose backing service was down", () => {
		assert.equal(classifyFailure("intercom not connected: protocol error", "tool").classId, "service-unavailable");
	});

	it("recommends argument repair, not turn retry, when a tool rejected the arguments", () => {
		// The two look alike and are not: one fails before any tool exists to
		// receive the call, the other when a real tool rejects real arguments.
		const parse = failureClass("malformed-tool-call")!.extensions.map((e) => e.pkg);
		const input = failureClass("tool-input-invalid")!.extensions.map((e) => e.pkg);
		assert.ok(parse.includes("@pedro_klein/pi-auto-retry"));
		assert.ok(!input.includes("@pedro_klein/pi-auto-retry"));
		assert.ok(input.includes("pi-tool-repair"));
	});

	it("reads only the ends of a huge result, so incidental output is not mistaken for the error", () => {
		// "Permission denied" printed in the middle of a long log is not why the
		// command failed; reading the whole blob would report it confidently.
		const noise = `${"ordinary output line\n".repeat(500)}Permission denied\n${"more output\n".repeat(500)}`;
		assert.equal(classifyFailure(noise, "tool").classId, "unclassified");
		// At the end, where a shell actually puts it, it is still found.
		assert.equal(classifyFailure(`${"output\n".repeat(500)}Permission denied`, "tool").classId, "permission-denied");
	});

	// The residual classes. A first run over a real day left 31% of failures
	// unnamed; profiling what was left showed three genuinely different things
	// hiding in it, and naming them took the residual to 10%.
	it("does not call an unfinished background task a failure", () => {
		const c = classifyFailure("(no output yet)", "tool");
		assert.equal(c.classId, "pending-background-task");
		assert.equal(failureClass("pending-background-task")!.actionable, false);
	});

	it("names a command that reported its own error, and says which kind of tool", () => {
		assert.equal(classifyFailure("fatal: invalid reference: nope", "tool").classId, "command-failed");
		assert.equal(classifyFailure("sed: 1: bad flag in substitute command", "tool").classId, "command-failed");
		assert.equal(classifyFailure("cat: /tmp/x: Is a directory", "tool").classId, "command-failed");
		assert.equal(
			classifyFailure("sed: 1: bad flag", "tool").label,
			"a text tool reported an error",
		);
	});

	it("reads a diagnostic from an unnamed program only at the ends of the output", () => {
		// The Unix shape in the middle of ordinary output is not why it failed.
		assert.equal(classifyFailure("line one\nfrobnicator: something\nline three", "tool").classId, "unclassified");
		assert.equal(classifyFailure("frobnicator: something\nline two", "tool").classId, "command-failed");
		assert.equal(classifyFailure("line one\nfrobnicator: something", "tool").classId, "command-failed");
	});

	it("recognises a non-zero exit that was a signal, from the command alone", () => {
		// grep exits 1 when it finds nothing and prints nothing to explain itself,
		// so the result carries no evidence at all — only the call does.
		const c = classifyFailure("", "tool", { command: "grep -n TODO src/*.ts" });
		assert.equal(c.classId, "exit-status-signal");
		assert.equal(c.label, "a search that found nothing");

		assert.equal(classifyFailure("", "tool", { command: "git diff --exit-code" }).classId, "exit-status-signal");
		assert.equal(classifyFailure("", "tool", { command: "diff a.txt b.txt" }).classId, "exit-status-signal");
		assert.equal(classifyFailure("", "tool", { command: "test -f /tmp/x" }).classId, "exit-status-signal");
		assert.equal(classifyFailure("", "tool", { command: "cat file | rg pattern" }).classId, "exit-status-signal");
	});

	it("prefers a real diagnostic over the exit-status reading when the command left one", () => {
		// A grep that actually broke is a failure, not a search that found nothing.
		const c = classifyFailure("grep: repetition-operator operand invalid", "tool", { command: "grep -n '*x' f" });
		assert.equal(c.classId, "command-failed");
	});

	it("does not read an ordinary command's silence as a signal", () => {
		assert.equal(classifyFailure("", "tool", { command: "npm run build" }).classId, "unclassified");
	});

	it("classifies tool-axis errors against the tool catalogue, not the turn one", () => {
		assert.equal(classifyFailure("bash: frobnicate: command not found", "tool").classId, "tool-not-found");
		assert.equal(classifyFailure("ENOENT: no such file or directory", "tool").classId, "path-not-found");
		assert.equal(classifyFailure("Permission denied", "tool").classId, "permission-denied");
	});

	it("records only curated labels, never the matched text", () => {
		const secretish = "429: you (some-private-org-name) have reached your session usage limit";
		const c = classifyFailure(secretish, "turn");
		assert.ok(!c.label.includes("some-private-org-name"));
		assert.equal(c.label, "account usage limit reached");
	});
});

describe("the catalogue itself", () => {
	it("never recommends retrying a rejected credential", () => {
		// A retry extension here loops on the same rejection until the session dies.
		assert.deepEqual(failureClass("auth")!.extensions, []);
	});

	it("gives every actionable class a remedy that does not require a package", () => {
		for (const cls of [...TURN_FAILURE_CLASSES, ...TOOL_FAILURE_CLASSES]) {
			if (!cls.actionable) continue;
			assert.ok(cls.remedy.length > 20, `${cls.id} needs a remedy`);
		}
	});

	it("records a verified version and licence for every package it may name", () => {
		for (const cls of [...TURN_FAILURE_CLASSES, ...TOOL_FAILURE_CLASSES]) {
			for (const ext of cls.extensions) {
				assert.match(ext.verifiedVersion, /^\d+\.\d+\.\d+$/, `${ext.pkg} needs a verified version`);
				assert.ok(ext.license.length > 0, `${ext.pkg} needs a licence`);
			}
		}
	});

	it("exposes the closed set of packages anything may recommend", () => {
		const pkgs = curatedPackages();
		assert.ok(pkgs.includes("@pedro_klein/pi-auto-retry"));
		assert.equal(new Set(pkgs).size, pkgs.length, "no duplicates");
	});
});

// ──────────────────── the action stream ────────────────────

describe("buildToolStream", () => {
	it("pairs each result with the call that asked for it, not with the call beside it", () => {
		// Two calls in one step, and the SECOND one failed. A positional walk would
		// blame the first.
		const rows: MessageRow[] = [
			msg({
				id: "a1",
				role: "assistant",
				tool_calls: JSON.stringify([
					{ id: "c1", name: "read", arguments: { path: "/a" } },
					{ id: "c2", name: "read", arguments: { path: "/b" } },
				]),
			}),
			msg({
				id: "r1",
				role: "toolResult",
				tool_results: JSON.stringify([
					{ toolCallId: "c2", toolName: "read", isError: true, textLength: 5 },
					{ toolCallId: "c1", toolName: "read", isError: false, textLength: 9 },
				]),
			}),
		];
		const stream = buildToolStream(rows);
		assert.equal(stream.invocations[0]!.callId, "c1");
		assert.equal(stream.invocations[0]!.outcome!.isError, false);
		assert.equal(stream.invocations[1]!.callId, "c2");
		assert.equal(stream.invocations[1]!.outcome!.isError, true);
	});

	it("falls back to order for id-less legacy rows", () => {
		const rows: MessageRow[] = [
			msg({ id: "a1", role: "assistant", tool_calls: JSON.stringify([{ name: "bash", arguments: { command: "ls" } }]) }),
			msg({ id: "r1", role: "toolResult", tool_results: JSON.stringify([{ toolName: "bash", isError: true, textLength: 3 }]) }),
		];
		const stream = buildToolStream(rows);
		assert.equal(stream.invocations[0]!.outcome!.isError, true);
	});

	it("treats a call that never got a result as unfinished, not as failed", () => {
		const rows = callAndResult("c1", "bash", { command: "ls" });
		const stream = buildToolStream(rows);
		assert.equal(stream.invocations[0]!.outcome, null);
	});

	it("attaches error text only when the row carried a single result", () => {
		const single = buildToolStream(callAndResult("c1", "bash", {}, { isError: true, text: "Permission denied" }));
		assert.equal(single.invocations[0]!.outcome!.errorText, "Permission denied");

		// Two results share one text field; splitting them apart would attribute one
		// tool's error to the other.
		const rows: MessageRow[] = [
			msg({
				id: "a1",
				role: "assistant",
				tool_calls: JSON.stringify([
					{ id: "c1", name: "read", arguments: {} },
					{ id: "c2", name: "read", arguments: {} },
				]),
			}),
			msg({
				id: "r1",
				role: "toolResult",
				content_text: "Permission denied\nok",
				tool_results: JSON.stringify([
					{ toolCallId: "c1", toolName: "read", isError: true, textLength: 17 },
					{ toolCallId: "c2", toolName: "read", isError: false, textLength: 2 },
				]),
			}),
		];
		assert.equal(buildToolStream(rows).invocations[0]!.outcome!.errorText, null);
	});

	it("reports a failed generation, with its cost", () => {
		const stream = buildToolStream([assistantFailure("a1", "Connection error.", 0.02)]);
		assert.equal(stream.turnFailures.length, 1);
		assert.equal(stream.turnFailures[0]!.costUsd, 0.02);
	});

	it("reports whether the stop reason was captured at all", () => {
		assert.equal(buildToolStream([msg({ role: "assistant" })]).coverage.stopReasonRecorded, false);
		assert.equal(
			buildToolStream([msg({ role: "assistant", stop_reason: "stop" })]).coverage.stopReasonRecorded,
			true,
		);
	});
});

// ──────────────────── grouping and pricing ────────────────────

describe("groupFailures", () => {
	it("groups repeats of one class together and counts them", () => {
		const groups = groupFailures(
			buildToolStream([
				assistantFailure("a1", "429: rate limit exceeded"),
				assistantFailure("a2", "429: rate limit exceeded"),
				assistantFailure("a3", "Connection error."),
			]),
		);
		const rate = groups.find((g) => g.class_id === "rate-limit")!;
		assert.equal(rate.count, 2);
		assert.deepEqual(rate.message_ids, ["a1", "a2"]);
		assert.equal(groups.find((g) => g.class_id === "provider-transport")!.count, 1);
	});

	it("collapses the same failure differing only by a request id into one cause", () => {
		const groups = groupFailures(
			buildToolStream([
				assistantFailure("a1", "500: Internal Server Error (ref: aaaaaaaa1111)"),
				assistantFailure("a2", "500: Internal Server Error (ref: bbbbbbbb2222)"),
			]),
		);
		const g = groups.find((c) => c.class_id === "provider-server")!;
		assert.equal(g.count, 2);
		assert.equal(g.causes.length, 1, "one cause, seen twice — not two distinct errors");
		assert.equal(g.causes[0]!.count, 2);
	});

	it("never stores the raw error text", () => {
		const groups = groupFailures(
			buildToolStream([assistantFailure("a1", "429: you (a-private-org) have reached your session usage limit")]),
		);
		assert.ok(!JSON.stringify(groups).includes("a-private-org"));
	});

	it("prices what was priced and counts what was not, never inventing a zero", () => {
		const groups = groupFailures(
			buildToolStream([
				assistantFailure("a1", "Connection error.", 0.05),
				assistantFailure("a2", "Connection error.", null),
			]),
		);
		const g = groups[0]!;
		assert.equal(g.cost_usd, 0.05);
		assert.equal(g.priced_count, 1);
		assert.equal(g.unpriced_count, 1);
	});

	it("leaves cost null when nothing was priced", () => {
		const groups = groupFailures(buildToolStream([assistantFailure("a1", "Connection error.", null)]));
		assert.equal(groups[0]!.cost_usd, null);
	});

	it("keys tool failures by tool, so two tools do not merge", () => {
		const groups = groupFailures(
			buildToolStream([
				...callAndResult("c1", "bash", {}, { isError: true, text: "Permission denied" }),
				...callAndResult("c2", "read", {}, { isError: true, text: "Permission denied" }),
			]),
		);
		const denied = groups.filter((g) => g.class_id === "permission-denied");
		assert.equal(denied.length, 2);
		assert.deepEqual(denied.map((g) => g.tool).sort(), ["bash", "read"]);
	});

	it("counts failures the catalogue could not name", () => {
		const groups = groupFailures(buildToolStream([assistantFailure("a1", "a brand new kind of error")]));
		assert.equal(unclassifiedCount(groups), 1);
	});
});

describe("classification from the call", () => {
	it("groups a silent grep failure under the signal class, keyed by the command", () => {
		const groups = groupFailures(buildToolStream(failedBashCalls(["grep -n A f", "grep -n B f", "grep -n A f"])));
		const g = groups.find((x) => x.class_id === "exit-status-signal")!;
		assert.equal(g.count, 3);
		// Two distinct commands, so two distinct causes — the repeat collapses.
		assert.equal(g.causes.length, 2);
		assert.ok(!JSON.stringify(g).includes("grep -n"), "the command is fingerprinted, never stored");
	});
});

describe("normalizeForFingerprint", () => {
	it("folds away request ids, counts, paths and parenthesised names", () => {
		const a = normalizeForFingerprint("Internal Server Error (ref: aaaaaaaa1111) after 3 attempts at /var/run/x");
		const b = normalizeForFingerprint("Internal Server Error (ref: bbbbbbbb2222) after 9 attempts at /tmp/other/y");
		assert.equal(a, b);
	});

	it("keeps genuinely different errors apart", () => {
		assert.notEqual(normalizeForFingerprint("Connection error."), normalizeForFingerprint("Request timed out."));
	});
});

// ──────────────────── proposals ────────────────────

function proposalsFor(rows: MessageRow[], over: Partial<typeof DEFAULT_FAILURE_MODES_CONFIG> = {}, installed = NO_INSTALLS) {
	const stream = buildToolStream(rows);
	return buildProposals({
		sessionId: "s1",
		groups: groupFailures(stream),
		assistantTurnCount: stream.coverage.assistantTurnCount,
		toolCallCount: stream.coverage.toolCallCount,
		installed,
		config: { ...DEFAULT_FAILURE_MODES_CONFIG, ...over },
	});
}

describe("buildProposals", () => {
	it("stays silent below the threshold", () => {
		assert.deepEqual(proposalsFor([assistantFailure("a1", "Connection error."), assistantFailure("a2", "Connection error.")]), []);
	});

	it("proposes an extension, with the exact package spec, once the threshold is cleared", () => {
		const [p] = proposalsFor([
			assistantFailure("a1", "Connection error."),
			assistantFailure("a2", "Connection error."),
			assistantFailure("a3", "Connection error."),
		]);
		assert.equal(p!.target_type, "extension");
		assert.match(p!.target_path!, /^npm:/);
		assert.ok(curatedPackages().includes(p!.target_path!.slice("npm:".length)));
	});

	it("never proposes on an abort", () => {
		assert.deepEqual(
			proposalsFor([
				assistantFailure("a1", "This operation was aborted"),
				assistantFailure("a2", "This operation was aborted"),
				assistantFailure("a3", "This operation was aborted"),
			]),
			[],
		);
	});

	it("never proposes on an unrecognised failure", () => {
		// An unnamed failure is a gap in the catalogue, not something to act on.
		assert.deepEqual(
			proposalsFor([
				assistantFailure("a1", "wholly novel"),
				assistantFailure("a2", "wholly novel"),
				assistantFailure("a3", "wholly novel"),
			]),
			[],
		);
	});

	it("skips a package that is already installed and offers the next one", () => {
		const rows = [
			assistantFailure("a1", "Connection error."),
			assistantFailure("a2", "Connection error."),
			assistantFailure("a3", "Connection error."),
		];
		const [baseline] = proposalsFor(rows);
		const firstPick = baseline!.target_path!.slice("npm:".length);
		const [p] = proposalsFor(rows, {}, { names: new Set([firstPick]), known: true });
		assert.notEqual(p!.target_path, baseline!.target_path);
		assert.ok(p!.detail.includes("Already installed"));
	});

	it("falls back to the package-free remedy when every candidate is installed", () => {
		const rows = [
			assistantFailure("a1", "Connection error."),
			assistantFailure("a2", "Connection error."),
			assistantFailure("a3", "Connection error."),
		];
		const [p] = proposalsFor(rows, {}, { names: new Set(curatedPackages()), known: true });
		assert.notEqual(p!.target_type, "extension");
		assert.ok(p!.detail.includes("already installed"));
	});

	it("says so when the installed check could not run", () => {
		const [p] = proposalsFor(
			[
				assistantFailure("a1", "Connection error."),
				assistantFailure("a2", "Connection error."),
				assistantFailure("a3", "Connection error."),
			],
			{},
			{ names: new Set(), known: false },
		);
		assert.ok(p!.detail.includes("could not be read"));
	});

	it("proposes a package-free remedy for auth, which no retry can fix", () => {
		const [p] = proposalsFor([
			assistantFailure("a1", "401: Unauthorized"),
			assistantFailure("a2", "401: Unauthorized"),
			assistantFailure("a3", "401: Unauthorized"),
		]);
		assert.notEqual(p!.target_type, "extension");
		assert.ok(p!.detail.includes("no retry extension"));
	});

	it("quotes the measured rate and the priced cost as a stated lower bound", () => {
		const [p] = proposalsFor([
			assistantFailure("a1", "429: rate limit", 0.01),
			assistantFailure("a2", "429: rate limit", 0.01),
			assistantFailure("a3", "429: rate limit", null),
		]);
		assert.ok(p!.summary.includes("$0.0200"));
		assert.ok(p!.summary.includes("lower bound"));
		assert.ok(p!.summary.includes("100.0%"), "3 of 3 assistant turns failed");
	});

	it("says the cost is unknown rather than quoting zero", () => {
		const [p] = proposalsFor([
			assistantFailure("a1", "429: rate limit"),
			assistantFailure("a2", "429: rate limit"),
			assistantFailure("a3", "429: rate limit"),
		]);
		assert.ok(p!.summary.includes("unknown"));
		assert.ok(!p!.summary.includes("$0.00"));
	});

	it("merges repeated causes in the evidence instead of listing them one by one", () => {
		const [p] = proposalsFor(failedBashCalls(["grep -n A f", "grep -n B f", "grep -n C f"]));
		assert.ok(p!.evidence.includes("a search that found nothing ×3"));
		assert.ok(!p!.evidence.includes("×1;"), "three distinct commands, one cause the reader cares about");
	});

	it("does not say a call 'failed' when the class is that nothing failed", () => {
		const [p] = proposalsFor(failedBashCalls(["grep -n X0 f", "grep -n X1 f", "grep -n X2 f"]));
		assert.ok(!p!.title.includes("failed"));
		assert.ok(!p!.summary.includes("failed with"));
		assert.ok(p!.detail.includes("|| true"));
	});

	it("never proposes on an unfinished background task", () => {
		const rows: MessageRow[] = [];
		for (let i = 0; i < 5; i++) {
			const id = `c${i}`;
			rows.push(
				msg({ id: `a-${id}`, role: "assistant", tool_calls: JSON.stringify([{ id, name: "bash", arguments: { command: "check" } }]) }),
				msg({
					id: `r-${id}`,
					role: "toolResult",
					content_text: "(no output yet)",
					tool_results: JSON.stringify([{ toolCallId: id, toolName: "bash", isError: true, textLength: 15 }]),
				}),
			);
		}
		assert.deepEqual(proposalsFor(rows), []);
	});

	it("tells the reader nothing is installed for them", () => {
		const [p] = proposalsFor([
			assistantFailure("a1", "Connection error."),
			assistantFailure("a2", "Connection error."),
			assistantFailure("a3", "Connection error."),
		]);
		assert.ok(p!.detail.includes("nothing is installed for you"));
	});
});

// ──────────────────── the installed-package check ────────────────────

describe("normalizePackageSpec", () => {
	it("reads an npm spec, with or without a version", () => {
		assert.equal(normalizePackageSpec("npm:@scope/name"), "@scope/name");
		assert.equal(normalizePackageSpec("npm:@scope/name@1.2.3"), "@scope/name");
		assert.equal(normalizePackageSpec("npm:plain-name@2"), "plain-name");
	});

	it("ignores git installs, which the registry catalogue cannot speak for", () => {
		assert.equal(normalizePackageSpec("git:github.com/owner/repo@main"), null);
		assert.equal(normalizePackageSpec({ source: "git:github.com/owner/repo" }), null);
	});

	it("reads the object form", () => {
		assert.equal(normalizePackageSpec({ source: "npm:@scope/name" }), "@scope/name");
	});

	it("ignores anything else", () => {
		assert.equal(normalizePackageSpec(null), null);
		assert.equal(normalizePackageSpec(42), null);
	});
});

describe("readInstalledPackages", () => {
	it("reads the host's package list", () => {
		const file = path.join(os.tmpdir(), `prospect-settings-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
		fs.writeFileSync(file, JSON.stringify({ packages: ["npm:@scope/a", "git:github.com/x/y", { source: "npm:b" }] }));
		const got = readInstalledPackages(file);
		assert.equal(got.known, true);
		assert.deepEqual([...got.names].sort(), ["@scope/a", "b"]);
		fs.unlinkSync(file);
	});

	it("reports 'not known' rather than 'nothing installed' when the file is missing", () => {
		const got = readInstalledPackages(path.join(os.tmpdir(), "prospect-settings-definitely-absent.json"));
		assert.equal(got.known, false);
	});

	it("reports 'not known' rather than throwing on malformed settings", () => {
		const file = path.join(os.tmpdir(), `prospect-settings-bad-${Date.now()}.json`);
		fs.writeFileSync(file, "{not json");
		assert.equal(readInstalledPackages(file).known, false);
		fs.unlinkSync(file);
	});
});
