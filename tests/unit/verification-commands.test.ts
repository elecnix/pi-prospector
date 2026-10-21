/**
 * Unit tests for the verification-commands analyzer: which shell commands
 * verify the working tree.
 *
 * Pure functions, no database, no mocks, no real session data — hand-written
 * synthetic rows only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_VERIFICATION_COMMANDS_CONFIG,
	type VerificationCommandsConfig,
} from "../../src/analyze/analyzers/verification-commands/config.js";
import {
	nominateCommands,
	parseVerificationDecision,
} from "../../src/analyze/analyzers/verification-commands/index.js";
import { normaliseCommand } from "../../src/analyze/analyzers/stale-verification/command-vocabulary.js";
import { VERIFICATION_DECISION_QUESTIONS } from "../../src/analyze/analyzers/verification-commands/decision.js";
import type { MessageRow } from "../../src/analyze/types.js";

const CONFIG: VerificationCommandsConfig = { ...DEFAULT_VERIFICATION_COMMANDS_CONFIG };

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
function at(s: number): string {
	return new Date(T0 + s * 1000).toISOString();
}

let seq = 0;
function row(partial: Partial<MessageRow> & { role: string }): MessageRow {
	return {
		id: partial.id ?? `row-${seq++}`,
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

/** A shell call and its result, `seconds` long. */
function sh(id: string, command: string, s: number, seconds: number): MessageRow[] {
	return [
		row({ id: `call-${id}`, role: "assistant", timestamp: at(s), tool_calls: JSON.stringify([{ id, name: "bash", arguments: { command } }]) }),
		row({
			id: `res-${id}`,
			role: "toolResult",
			timestamp: at(s + seconds),
			tool_results: JSON.stringify([{ toolCallId: id, toolName: "bash", isError: false, textLength: 12 }]),
		}),
	];
}

/** An edit-tool call and its result. */
function edit(id: string, path: string, s: number): MessageRow[] {
	return [
		row({ id: `call-${id}`, role: "assistant", timestamp: at(s), tool_calls: JSON.stringify([{ id, name: "edit", arguments: { path } }]) }),
		row({
			id: `res-${id}`,
			role: "toolResult",
			timestamp: at(s + 1),
			tool_results: JSON.stringify([{ toolCallId: id, toolName: "edit", isError: false, textLength: 12 }]),
		}),
	];
}

// ─────────────────────────── nomination ───────────────────────────

describe("nominateCommands", () => {
	it("nominates a command that no default pattern matches and that a commit followed", () => {
		const candidates = nominateCommands(
			[...sh("v1", "tools/ci/verify-all", 0, 120), ...sh("c1", "git commit -m 'chore: bump'", 130, 1)],
			CONFIG,
		);
		assert.deepEqual(candidates.map((c) => c.command), ["tools/ci/verify-all"]);
		assert.equal(candidates[0]!.seconds, 120);
	});

	it("nominates a command that ran twice with an edit between", () => {
		const candidates = nominateCommands(
			[
				...sh("v1", "tools/ci/verify-all", 0, 120),
				...edit("e1", "src/a.ts", 130),
				...sh("v2", "tools/ci/verify-all", 200, 120),
			],
			CONFIG,
		);
		assert.deepEqual(candidates.map((c) => c.command), ["tools/ci/verify-all"]);
	});

	it("does not nominate a command that ran once, briefly", () => {
		assert.deepEqual(nominateCommands([...sh("v1", "ls -la", 0, 5)], CONFIG), []);
	});

	it("does not nominate a command that ran once with no commit after it", () => {
		assert.deepEqual(nominateCommands([...sh("v1", "tools/ci/verify-all", 0, 120)], CONFIG), []);
	});

	it("does not nominate a command that matches a default verification pattern", () => {
		// The shipped patterns already cover it, so the model never pays for it.
		assert.deepEqual(nominateCommands([...sh("v1", "npm test", 0, 120), ...sh("c1", "git commit -m x", 130, 1)], CONFIG), []);
	});

	it("does not nominate a line whose command the patterns cover behind another segment", () => {
		// The detector matches a segment, so the nomination must too: the corpus
		// must not pay a model call for a verdict the pattern list already has.
		assert.deepEqual(
			nominateCommands([...sh("v1", "cd /repo && npm test", 0, 120), ...sh("c1", "git commit -m x", 130, 1)], CONFIG),
			[],
		);
	});

	it("nominates each distinct command once, keeping the longest run", () => {
		const candidates = nominateCommands(
			[
				...sh("v1", "tools/ci/verify-all", 0, 120),
				...edit("e1", "src/a.ts", 130),
				...sh("v2", "tools/ci/verify-all", 200, 300),
			],
			CONFIG,
		);
		assert.equal(candidates.length, 1);
		assert.equal(candidates[0]!.seconds, 300);
		assert.equal(candidates[0]!.runs, 2);
	});

	it("normalises a command so the same command under a different directory is one entry", () => {
		assert.equal(normaliseCommand("tools/ci/verify-all"), "tools/ci/verify-all");
		assert.equal(normaliseCommand("  tools/ci/verify-all  "), "tools/ci/verify-all");
		assert.equal(normaliseCommand("./tools/ci/verify-all"), "tools/ci/verify-all");
	});
});

// ─────────────────────────── decision ───────────────────────────

describe("parseVerificationDecision", () => {
	it("reads a full verdict", () => {
		const verdict = parseVerificationDecision({
			answers: {
				verifies: { type: "choice", choice: "full", confidence: 0.9, probabilities: { full: 0.9, narrow: 0.05, not_verification: 0.05 } },
			},
			model: "jev-1.13.0",
			costUsd: 0,
			inputTokens: 0,
			outputTokens: 0,
			durationMs: 0,
		});
		assert.equal(verdict.verdict, "full");
		assert.equal(verdict.confidence, 0.9);
	});

	it("rejects a response with no verdict", () => {
		assert.throws(
			() =>
				parseVerificationDecision({
					answers: {},
					model: "jev-1.13.0",
					costUsd: 0,
					inputTokens: 0,
					outputTokens: 0,
					durationMs: 0,
				}),
			/no choice answer for 'verifies'/,
		);
	});
});

describe("VERIFICATION_DECISION_QUESTIONS", () => {
	it("asks one question with a full, narrow, and not-verification option", () => {
		const question = VERIFICATION_DECISION_QUESTIONS["verifies"];
		assert.ok(question);
		assert.equal(question.type, "choice");
		assert.deepEqual(Object.keys(question.criteria).sort(), ["full", "narrow", "not_verification"]);
	});
});
