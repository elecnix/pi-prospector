/**
 * Unit tests for the grounded-claims consistency checks (issue #100). Pure
 * functions over hand-written synthetic message rows — no database, no mocks,
 * no real session data.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GROUNDED_CLAIMS_CONFIG } from "../../src/analyze/analyzers/grounded-claims/config.js";
import {
	extractClaims,
	scanConsistencySignals,
	UNACTED_REQUEST,
	UNGROUNDED_CLAIM,
	type ConsistencySignal,
} from "../../src/analyze/analyzers/grounded-claims/detect.js";
import type { MessageRow } from "../../src/analyze/types.js";

const CONFIG = { ...DEFAULT_GROUNDED_CLAIMS_CONFIG };

// ─────────────────────────── row helpers ───────────────────────────

let seq = 0;

function user(text: string): MessageRow {
	const id = `um-${seq++}`;
	return {
		id,
		session_id: "s",
		parent_id: null,
		timestamp: null,
		role: "user",
		content_text: text,
		content_thinking: null,
		tool_calls: null,
		tool_results: null,
		model: null,
		cost_usd: null,
		stop_reason: null,
		error_message: null,
	};
}

function assistant(text: string, calls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): MessageRow {
	const id = `am-${seq++}`;
	return {
		id,
		session_id: "s",
		parent_id: null,
		timestamp: null,
		role: "assistant",
		content_text: text || null,
		content_thinking: null,
		tool_calls: calls ? JSON.stringify(calls) : null,
		tool_results: null,
		model: null,
		cost_usd: null,
		stop_reason: calls ? "toolUse" : "end_turn",
		error_message: null,
	};
}

function toolResult(callId: string, text: string): MessageRow {
	const id = `tr-${seq++}`;
	return {
		id,
		session_id: "s",
		parent_id: null,
		timestamp: null,
		role: "toolResult",
		content_text: text,
		content_thinking: null,
		tool_calls: null,
		tool_results: JSON.stringify([{ toolCallId: callId, toolName: "", isError: false, textLength: text.length }]),
		model: null,
		cost_usd: null,
		stop_reason: null,
		error_message: null,
	};
}

function bashCall(id: string, command: string) {
	return { id, name: "bash", arguments: { command } };
}

function signalsOfKind(signals: ConsistencySignal[], kind: string): ConsistencySignal[] {
	return signals.filter((s) => s.signal === kind);
}

// ─────────────────────────── claim extraction ───────────────────────────

describe("extractClaims", () => {
	it("extracts paths, numbers, counts, percentages and line refs", () => {
		const claims = extractClaims("Fixed src/auth/login.ts — all 128 tests pass, coverage at 85%, build took 2400 ms. See L42.");
		const kinds = new Set(claims.map((c) => c.kind));
		assert.ok(kinds.has("path"), "path extracted");
		assert.ok(kinds.has("number"), "bare multi-digit number extracted");
		assert.ok(kinds.has("count"), "count-noun number extracted");
		assert.ok(kinds.has("percentage"), "percentage extracted");
		assert.ok(kinds.has("line-ref"), "L42 line ref extracted");
	});

	it("does not extract single-digit bare numbers or version-suffixed tokens", () => {
		const claims = extractClaims("Step 3 of v2 took 7 ms");
		for (const c of claims.filter((c) => c.kind === "number")) {
			assert.notEqual(c.value, "3", "single digit is noise");
			assert.notEqual(c.value, "7", "single digit is noise");
			assert.notEqual(c.value, "2", "v2 suffix is not a claim");
		}
	});

	it("normalizes path separators", () => {
		const claims = extractClaims("Wrote src\\auth\\login.ts successfully.");
		const path = claims.find((c) => c.kind === "path");
		assert.ok(path, "windows-style path extracted");
		assert.equal(path!.value, "src/auth/login.ts");
	});
});

// ─────────────────────────── ungrounded-claim check ───────────────────────────

describe("ungrounded-claim check", () => {
	describe("stays quiet when the claim is grounded or not the agent's", () => {
		// Three ways an ungrounded-claim check must hold its fire: every stated
		// fact appears verbatim in the turn's tool results, only the path of a
		// file:line reference appears there, or the fact was introduced by the
		// user rather than fabricated by the assistant.
		const quietCases: Array<{ name: string; rows: MessageRow[]; why: string }> = [
			{
				name: "stays quiet when the claimed number and path appear in the turn's tool results",
				rows: [
					user("Fix the failing tests."),
					assistant("", [bashCall("c1", "npm test")]),
					toolResult("c1", "128 tests passing, wrote results to src/reports/junit.xml"),
					assistant("All 128 tests pass. Full report written to src/reports/junit.xml."),
				],
				why: "grounded claims stay quiet",
			},
			{
				name: "grounds a file:line location on the path alone appearing in results",
				rows: [
					user("Find the bug."),
					assistant("", [bashCall("c1", "grep -rn TODO src/")]),
					toolResult("c1", "src/index.ts:10: TODO fix later"),
					assistant("The marker sits at src/index.ts:42."),
				],
				why: "location grounded by its path",
			},
			{
				name: "excludes claims the user introduced themselves",
				rows: [
					user("Look at src/auth/session.ts and tell me what's wrong with it."),
					assistant("", [bashCall("c1", "cat README.md")]),
					toolResult("c1", "# readme"),
					assistant("I reviewed src/auth/session.ts as you asked."),
				],
				why: "user-provided facts are context, not fabrication",
			},
		];
		for (const c of quietCases) {
			it(c.name, () => {
				assert.deepEqual(signalsOfKind(scanConsistencySignals(c.rows, CONFIG), UNGROUNDED_CLAIM), [], c.why);
			});
		}
	});

	it("fires when a claimed number appears nowhere in the tool results", () => {
		const rows = [
			user("Fix the failing tests."),
			assistant("", [bashCall("c1", "npm test")]),
			toolResult("c1", "12 tests passing"),
			assistant("All 128 tests pass now."),
		];
		const signals = scanConsistencySignals(rows, CONFIG);
		const ungrounded = signalsOfKind(signals, UNGROUNDED_CLAIM);
		assert.equal(ungrounded.length, 1, "one stated fact is one claim: " + JSON.stringify(signals));
		assert.ok(["number", "count"].includes(ungrounded[0]!.claimKind));
		assert.match(ungrounded[0]!.detail, /128/);
	});

	it("fires when a claimed path appears nowhere in the tool results", () => {
		const rows = [
			user("Check the auth flow."),
			assistant("", [bashCall("c1", "npm test")]),
			toolResult("c1", "ok"),
			assistant("The bug was in src/auth/session.ts."),
		];
		const signals = scanConsistencySignals(rows, CONFIG);
		const ungrounded = signalsOfKind(signals, UNGROUNDED_CLAIM);
		assert.equal(ungrounded.length, 1);
		assert.equal(ungrounded[0]!.claimKind, "path");
	});

	it("stays quiet when the turn had no tool results at all", () => {
		const rows = [
			user("What does the config do?"),
			assistant("It has 128 settings across 4 modules."),
		];
		const signals = scanConsistencySignals(rows, CONFIG);
		assert.deepEqual(signalsOfKind(signals, UNGROUNDED_CLAIM), [], "nothing to ground against, nothing provable");
	});
});

// ─────────────────────────── unacted-request check ───────────────────────────

describe("unacted-request check", () => {
	it("fires when the user asked to run the tests and no call matched", () => {
		const rows = [
			user("Please run the tests before we continue."),
			assistant("Everything looks good to me!"),
		];
		const signals = scanConsistencySignals(rows, CONFIG);
		const unacted = signalsOfKind(signals, UNACTED_REQUEST);
		assert.equal(unacted.length, 1);
		assert.equal(unacted[0]!.requestType, "test-run");
	});

	it("stays quiet when a matching test-runner call ran in the same turn", () => {
		const rows = [
			user("Please run the tests before we continue."),
			assistant("", [bashCall("c1", "npm test")]),
			toolResult("c1", "ok"),
			assistant("Tests pass."),
		];
		const signals = scanConsistencySignals(rows, CONFIG);
		assert.deepEqual(signalsOfKind(signals, UNACTED_REQUEST), []);
	});

	it("stays quiet when the matching action happened in the immediately following turn", () => {
		const rows = [
			user("Please run the tests before we continue."),
			assistant("On it."),
			user("Thanks."),
			assistant("", [bashCall("c2", "npx vitest run")]),
			toolResult("c2", "ok"),
			assistant("Done, green."),
		];
		const signals = scanConsistencySignals(rows, CONFIG);
		assert.deepEqual(signalsOfKind(signals, UNACTED_REQUEST), [], "acknowledge-then-act pattern satisfied");
	});

	it("does not read slash-command lines or questions as requests", () => {
		const rows = [
			user("/compact\nDid you run the tests earlier today?"),
			assistant("I ran them yesterday; want me to compact anything else?"),
		];
		const signals = scanConsistencySignals(rows, CONFIG);
		assert.deepEqual(signalsOfKind(signals, UNACTED_REQUEST), [], "/command lines and questions are not requests");
	});

	it("does not read negated imperatives as requests", () => {
		const rows = [
			user("Don't run the tests yet, we're still editing."),
			assistant("Understood, holding off."),
		];
		const signals = scanConsistencySignals(rows, CONFIG);
		assert.deepEqual(signalsOfKind(signals, UNACTED_REQUEST), []);
	});

	it("matches each catalogue request type to its own action", () => {
		const cases: Array<{ request: string; command: string; type: string }> = [
			{ request: "Open a PR for this branch.", command: "gh pr create --fill", type: "pr-create" },
			{ request: "Commit the changes.", command: 'git commit -am "fix"', type: "commit" },
			{ request: "Push to origin.", command: "git push origin HEAD", type: "push" },
			{ request: "Build the project.", command: "npm run build", type: "build-run" },
		];
		for (const c of cases) {
			const acted = [
				user(c.request),
				assistant("", [bashCall(`c-${c.type}`, c.command)]),
				toolResult(`c-${c.type}`, "ok"),
				assistant("Done."),
			];
			assert.deepEqual(
				signalsOfKind(scanConsistencySignals(acted, CONFIG), UNACTED_REQUEST),
				[],
				`${c.type} satisfied by "${c.command}"`,
			);
			const unacted = [user(c.request), assistant("Sure thing!")];
			const fired = signalsOfKind(scanConsistencySignals(unacted, CONFIG), UNACTED_REQUEST);
			assert.equal(fired.length, 1, `${c.request} fires without action`);
			assert.equal(fired[0]!.requestType, c.type);
		}
	});

	it("fires for delete requests only satisfied by removing the named path", () => {
		const target = "src/old-module/index.ts";
		const base = "index.ts";
		const unacted = [user(`Delete ${target} please.`), assistant("I removed it.")];
		const fired = signalsOfKind(scanConsistencySignals(unacted, CONFIG), UNACTED_REQUEST);
		assert.equal(fired.length, 1, "answering without acting fires");
		assert.equal(fired[0]!.requestType, "delete-target");

		const wrongFile = [
			user(`Delete ${target} please.`),
			assistant("", [bashCall("rm1", "rm src/other/file.ts")]),
			toolResult("rm1", "removed"),
			assistant("Removed."),
		];
		assert.equal(signalsOfKind(scanConsistencySignals(wrongFile, CONFIG), UNACTED_REQUEST).length, 1, "removing a different path does not satisfy it");

		const rightFile = [
			user(`Delete ${target} please.`),
			assistant("", [bashCall("rm2", `rm src/old-module/${base}`)]),
			toolResult("rm2", "removed"),
			assistant("Removed."),
		];
		assert.deepEqual(signalsOfKind(scanConsistencySignals(rightFile, CONFIG), UNACTED_REQUEST), [], "removing the named path satisfies it");
	});

	it("skips delete requests whose object is not path-shaped", () => {
		const rows = [user("Delete the debug logging."), assistant("That logging lives in three places.")];
		const signals = scanConsistencySignals(rows, CONFIG);
		assert.deepEqual(signalsOfKind(signals, UNACTED_REQUEST), [], "non-path objects are too vague to accuse on");
	});
});
