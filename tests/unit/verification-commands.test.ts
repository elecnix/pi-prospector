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
	verificationCommandsByCommand,
} from "../../src/analyze/analyzers/verification-commands/index.js";
import { redactCommandLine } from "../../src/analyze/analyzers/verification-commands/redact.js";
import { normaliseCommand } from "../../src/analyze/analyzers/stale-verification/command-vocabulary.js";
import { VERIFICATION_DECISION_QUESTIONS } from "../../src/analyze/analyzers/verification-commands/decision.js";
import type { MessageRow } from "../../src/analyze/types.js";
import { makeMessageRow as row } from "./helpers.js";

const CONFIG: VerificationCommandsConfig = { ...DEFAULT_VERIFICATION_COMMANDS_CONFIG };

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
function at(s: number): string {
	return new Date(T0 + s * 1000).toISOString();
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

	it("nominates a command that matches a shape", () => {
		// The two shapes a gate run takes.
		const cases: Array<{ rule: string; messages: MessageRow[] }> = [
			{
				rule: "it ran twice with an edit between",
				messages: [
					...sh("v1", "tools/ci/verify-all", 0, 120),
					...edit("e1", "src/a.ts", 130),
					...sh("v2", "tools/ci/verify-all", 200, 120),
				],
			},
			{
				rule: "it ran twice with no edit between and a commit after",
				messages: [
					...sh("v1", "tools/ci/verify-all", 0, 120),
					...sh("v2", "tools/ci/verify-all", 200, 120),
					...sh("c1", "git commit -m 'chore: bump'", 400, 1),
				],
			},
		];
		for (const c of cases) {
			const candidates = nominateCommands(c.messages, CONFIG);
			assert.deepEqual(candidates.map((x) => x.command), ["tools/ci/verify-all"], c.rule);
		}
	});

	it("does not nominate a command that matches neither shape", () => {
		// Each case is a command the corpus would learn nothing useful from.
		const cases: Array<{ rule: string; messages: MessageRow[] }> = [
			{ rule: "it ran once, briefly", messages: [...sh("v1", "ls -la", 0, 5)] },
			{ rule: "it ran once with no commit after it", messages: [...sh("v1", "tools/ci/verify-all", 0, 120)] },
			{
				rule: "it ran twice with no edit between and no commit",
				messages: [...sh("v1", "tools/ci/verify-all", 0, 120), ...sh("v2", "tools/ci/verify-all", 200, 120)],
			},
		];
		for (const c of cases) {
			assert.deepEqual(nominateCommands(c.messages, CONFIG), [], c.rule);
		}
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

	it("rejects a verdict outside the three options", () => {
		assert.throws(
			() =>
				parseVerificationDecision({
					answers: {
						verifies: { type: "choice", choice: "maybe", confidence: 0.5, probabilities: { maybe: 0.5 } },
					},
					model: "jev-1.13.0",
					costUsd: 0,
					inputTokens: 0,
					outputTokens: 0,
					durationMs: 0,
				}),
			/which is not one of full, narrow, not_verification/,
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

// ─────────────────────────── redaction ───────────────────────────

describe("redactCommandLine", () => {
	it("redacts a bearer token and keeps the rest of the line", () => {
		const out = redactCommandLine("curl -H 'Authorization: Bearer abc123def456' https://example.test/api");
		assert.ok(!out.includes("abc123def456"), "the token is gone");
		assert.match(out, /Authorization: Bearer <redacted>/);
		assert.match(out, /https:\/\/example\.test\/api/, "the rest of the line survives");
	});

	it("redacts the value of a secret-looking environment assignment", () => {
		const out = redactCommandLine("API_TOKEN=abc123def456 npm test");
		assert.ok(!out.includes("abc123def456"), "the value is gone");
		assert.match(out, /API_TOKEN=<redacted>/);
		assert.match(out, /npm test/, "the command itself survives");
	});

	it("leaves an environment assignment that is not a secret", () => {
		assert.equal(redactCommandLine("NODE_ENV=production npm test"), "NODE_ENV=production npm test");
	});

	it("redacts the credentials in a URL and keeps the host", () => {
		const out = redactCommandLine("git clone https://user:hunter2@example.test/repo.git");
		assert.ok(!out.includes("hunter2"), "the password is gone");
		assert.match(out, /example\.test/, "the host survives");
	});

	it("redacts a provider token in a command", () => {
		const out = redactCommandLine("gh auth login --with-token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
		assert.ok(!out.includes("ghp_aaaa"), "the token is gone");
	});

	it("redacts a password given as a flag", () => {
		const out = redactCommandLine("mysql -u root --password=hunter2");
		assert.ok(!out.includes("hunter2"), "the password is gone");
	});

	it("leaves an ordinary command untouched", () => {
		const line = "tools/ci/verify-all --verbose";
		assert.equal(redactCommandLine(line), line);
	});
});

// ─────────────────────────── reading the judged set ───────────────────────────

describe("verificationCommandsByCommand", () => {
	const node = (command: string, verdict: string, createdAt: string) => ({
		content_json: JSON.stringify({ command, verdict, confidence: 0.9 }),
		created_at: createdAt,
	});

	it("keeps the newest verdict for a command, whatever order the rows arrive in", () => {
		const older = node("tools/ci/verify-all", "narrow", "2026-01-01T00:00:00.000Z");
		const newer = node("tools/ci/verify-all", "full", "2026-02-01T00:00:00.000Z");
		for (const rows of [
			[older, newer],
			[newer, older],
		]) {
			const judged = verificationCommandsByCommand(rows);
			assert.equal(judged.get("tools/ci/verify-all")?.verdict, "full");
		}
	});

	it("drops a command the model judged not to verify", () => {
		const judged = verificationCommandsByCommand([node("ls -la", "not_verification", "2026-01-01T00:00:00.000Z")]);
		assert.equal(judged.size, 0);
	});

	it("keeps a dated verdict over an undated one", () => {
		// An undated row carries no age, so it must not displace a verdict that
		// has one.
		const dated = node("tools/ci/verify-all", "full", "2026-01-01T00:00:00.000Z");
		const undated = { content_json: JSON.stringify({ command: "tools/ci/verify-all", verdict: "narrow", confidence: 0.9 }) };
		for (const rows of [
			[dated, undated],
			[undated, dated],
		]) {
			const judged = verificationCommandsByCommand(rows);
			assert.equal(judged.get("tools/ci/verify-all")?.verdict, "full");
		}
	});

	it("keeps an undated verdict for a command no dated row speaks for", () => {
		const undated = { content_json: JSON.stringify({ command: "tools/ci/verify-all", verdict: "narrow", confidence: 0.9 }) };
		const judged = verificationCommandsByCommand([undated]);
		assert.equal(judged.get("tools/ci/verify-all")?.verdict, "narrow");
	});
});
