/**
 * Unit tests for the task-tool-mismatch pure detection functions (issue #158):
 * imperative instruction extraction with false-positive guards, target
 * resolution against an inventory, and substitute-call counting.
 * Pure functions, no database, no LLM.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	extractInstructedMentions,
	firstToken,
	resolveTargetTool,
	stripLeadIn,
	substituteBreakdown,
	ranInstructedCommand,
	type InstructedMention,
} from "../../src/analyze/analyzers/task-tool-mismatch/detect.js";
import { DEFAULT_TASK_TOOL_MISMATCH_CONFIG } from "../../src/analyze/analyzers/task-tool-mismatch/config.js";
import type { ToolInvocation } from "../../src/analyze/tool-stream.js";

const AVAILABLE = new Set(["read", "grep", "bash", "rg", "edit"]);

// ─────────────────────────── stripLeadIn ───────────────────────────

describe("stripLeadIn", () => {
	it("strips bullets, quotes, and polite lead-ins without flagging negation", () => {
		assert.deepEqual(stripLeadIn("- Run `git diff` first."), { rest: "Run `git diff` first.", negated: false });
		assert.deepEqual(stripLeadIn("1. Please run `make test`"), { rest: "run `make test`", negated: false });
		assert.deepEqual(stripLeadIn("“Now use `rg`.”"), { rest: "use `rg`.”", negated: false });
	});

	it("flags negated imperatives and consumes the negation", () => {
		assert.equal(stripLeadIn("Don't run `make test`.").negated, true);
		assert.equal(stripLeadIn("Do not use `bash` here").negated, true);
		assert.equal(stripLeadIn("Please don't run `make test`").negated, true);
	});
});

// ─────────────────────────── firstToken ───────────────────────────

describe("firstToken", () => {
	it("takes the command word of a backticked span", () => {
		assert.equal(firstToken("git diff origin/main...HEAD"), "git");
		assert.equal(firstToken(" make test "), "make");
		assert.equal(firstToken("npx vitest run --coverage"), "npx");
	});

	it("rejects spans that do not start with a command-shaped word", () => {
		assert.equal(firstToken(""), null);
		assert.equal(firstToken("--flag value"), null);
		assert.equal(firstToken("/usr/bin/env sh"), null);
	});
});

// ─────────────────────────── extractInstructedMentions ───────────────────────────

describe("extractInstructedMentions", () => {
	it("extracts backticked commands after imperative verbs", () => {
		const text = "Review this PR.\nRun `git diff origin/main...HEAD` and report.\nThen run `make test`.";
		const mentions = extractInstructedMentions(text, AVAILABLE);
		assert.deepEqual(mentions, [
			{ mention: "git", source: "backticked" },
			{ mention: "make", source: "backticked" },
		]);
	});

	it("accepts polite lead-ins and markdown bullets", () => {
		const mentions = extractInstructedMentionLines(["- Please run `make test`"], AVAILABLE);
		assert.deepEqual(mentions, [{ mention: "make", source: "backticked" }]);
	});

	it("extracts a bare word only when it names an available tool", () => {
		assert.deepEqual(extractInstructedMentions("First, use rg across the repo.", AVAILABLE), [
			{ mention: "rg", source: "known-tool" },
		]);
		assert.deepEqual(extractInstructedMentions("Use ripgrep across the repo.", AVAILABLE), []);
	});

	it("ignores prose mentions that are not imperative sentences", () => {
		const text =
			"You can use `rg` for fast search.\nThe reviewer should run `git diff` themselves.\nWe used grep last time.";
		assert.deepEqual(extractInstructedMentions(text, AVAILABLE), []);
	});

	it("ignores mid-sentence mentions without a sentence-initial verb", () => {
		assert.deepEqual(
			extractInstructedMentions("The task says to run `make test` before finishing.", AVAILABLE),
			[],
		);
	});

	it("drops negated imperatives even when sentence-initial", () => {
		assert.deepEqual(extractInstructedMentions("Don't run `make test`; it is slow.", AVAILABLE), []);
		assert.deepEqual(extractInstructedMentions("Do not use `bash` at all.", AVAILABLE), []);
	});

	it("does not treat 'do' as an instruction when it is not followed by 'not'", () => {
		// "Do" alone is not one of the imperative verbs; nothing fires.
		assert.deepEqual(extractInstructedMentions("Do `rg` over src/.", AVAILABLE), []);
	});

	it("dedupes repeated mentions and caps the count", () => {
		const text = "Run `git diff`. Run `git diff` again. Use `rg` too.";
		const mentions = extractInstructedMentions(text, AVAILABLE);
		assert.deepEqual(mentions.map((m) => m.mention), ["git", "rg"]);
	});
});

/** Run extraction line-by-line so bullet stripping is exercised per line. */
function extractInstructedMentionLines(lines: string[], available: ReadonlySet<string>): InstructedMention[] {
	return extractInstructedMentions(lines.join("\n"), available);
}

// ─────────────────────────── resolveTargetTool ───────────────────────────

describe("resolveTargetTool", () => {
	const cfg = DEFAULT_TASK_TOOL_MISMATCH_CONFIG;

	it("resolves directly when the name is itself an available tool", () => {
		assert.deepEqual(resolveTargetTool("rg", AVAILABLE, cfg), { resolution: "direct", tool: "rg" });
	});

	it("maps a shell command to the session's available shell tool", () => {
		assert.deepEqual(resolveTargetTool("git", AVAILABLE, cfg), { resolution: "shell-command", tool: "bash" });
	});

	it("is unavailable when neither the tool nor any shell tool exists", () => {
		assert.deepEqual(resolveTargetTool("rg", new Set(["read"]), cfg), {
			resolution: "unavailable",
			tool: null,
		});
	});
});

// ─────────────────────────── call counting ───────────────────────────

function invocation(name: string, args: Record<string, unknown> = {}): ToolInvocation {
	return {
		callId: "",
		name,
		args,
		messageId: "m0",
		ordinal: 0,
		outcome: null,
		costUsd: null,
	};
}

describe("substituteBreakdown", () => {
	it("counts only configured substitute tools", () => {
		const counts = substituteBreakdown(
			[invocation("read"), invocation("read"), invocation("grep"), invocation("edit"), invocation("web.search")],
			DEFAULT_TASK_TOOL_MISMATCH_CONFIG,
		);
		assert.deepEqual([...counts.entries()].sort(), [
			["grep", 1],
			["read", 2],
		]);
	});
});

describe("ranInstructedCommand", () => {
	it("matches the command word on a word boundary inside bash commands", () => {
		const calls = [invocation("bash", { command: "git status && ls" }), invocation("bash", { command: "echo done" })];
		assert.equal(ranInstructedCommand(calls, "git"), true);
		assert.equal(ranInstructedCommand(calls, "diff"), false);
		assert.equal(ranInstructedCommand(calls, "make"), false);
	});

	it("is false when no invocation carries a command argument", () => {
		assert.equal(ranInstructedCommand([invocation("read")], "git"), false);
	});
});
