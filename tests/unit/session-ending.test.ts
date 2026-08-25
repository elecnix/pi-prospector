/**
 * Unit tests for the session-ending analyzer's deterministic ending
 * classification (issue #102). Pure functions, no database, no mocks, no real
 * session data — hand-written synthetic rows only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SESSION_ENDING_CONFIG } from "../../src/analyze/analyzers/session-ending/config.js";
import type { SessionEndingConfig } from "../../src/analyze/analyzers/session-ending/config.js";
import { classifyEnding } from "../../src/analyze/analyzers/session-ending/detect.js";
import type { MessageRow } from "../../src/analyze/types.js";

const CONFIG: SessionEndingConfig = { ...DEFAULT_SESSION_ENDING_CONFIG };

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

function shellCall(id: string, command: string): Partial<MessageRow> {
	return {
		id: `call-${id}`,
		role: "assistant",
		stop_reason: "toolUse",
		tool_calls: JSON.stringify([{ id, name: "bash", arguments: { command } }]),
	};
}

function shellResult(callId: string, isError: boolean): Partial<MessageRow> {
	return {
		id: `res-${callId}`,
		role: "toolResult",
		tool_results: JSON.stringify([{ toolCallId: callId, toolName: "bash", isError, textLength: 10 }]),
	};
}

// ─────────────────────────── resolved ───────────────────────────

describe("resolved endings", () => {
	it("labels a wrap-up after a passing verification command", () => {
		const messages = [
			row({ role: "user", content_text: "Please fix the failing build and confirm it passes." }),
			row(shellCall("c1", "npm test")),
			row(shellResult("c1", false)),
			row({
				role: "assistant",
				content_text:
					"All tests pass now. The fix was in the cache invalidation path; here is a summary of the change.",
			}),
		];
		const scan = classifyEnding(messages, CONFIG);
		assert.equal(scan!.label, "resolved");
		assert.equal(scan!.evidence.rule, "verification_passed");
		assert.equal(scan!.evidence.verification_found, true);
		assert.equal(scan!.evidence.verification_ok, true);
		assert.equal(scan!.evidence.verification_pattern, DEFAULT_SESSION_ENDING_CONFIG.verificationPatterns[0]);
	});

	it("labels a wrap-up after successful ordinary tool work when no verification ran", () => {
		const messages = [
			row({ role: "user", content_text: "Read the config and tell me what port it uses." }),
			row({
				role: "assistant",
				// No call id and no result id: the transcript shape that exercises
				// the stream's FIFO fallback for legacy id-less pairs.
				tool_calls: JSON.stringify([{ name: "read", arguments: { file_path: "/tmp/app.conf" } }]),
				stop_reason: "toolUse",
			}),
			row({ id: "rr1", role: "toolResult", tool_results: JSON.stringify([{ toolName: "read", isError: false, textLength: 5 }]) }),
			row({
				role: "assistant",
				content_text: "The configuration sets the server to listen on port 8443 with TLS enabled by default.",
			}),
		];
		const scan = classifyEnding(messages, CONFIG);
		assert.equal(scan!.label, "resolved");
		assert.equal(scan!.evidence.rule, "summary_after_success");
		assert.equal(scan!.evidence.verification_found, false);
		assert.equal(scan!.evidence.verification_ok, null);
	});

	it("recognises git commit/push and gh pr create as verification-class commands", () => {
		for (const cmd of ["git commit -m 'fix'", "git push origin main", "gh pr create --title t"]) {
			const messages = [
				row({ role: "user", content_text: "Ship it." }),
				row(shellCall("v1", cmd)),
				row(shellResult("v1", false)),
				row({ role: "assistant", content_text: "Pushed and opened the PR; the branch is ready for review now." }),
			];
			const scan = classifyEnding(messages, CONFIG);
			assert.equal(scan!.label, "resolved", `command ${cmd} should count as verification`);
			assert.equal(scan!.evidence.rule, "verification_passed");
		}
	});
});

// ─────────────────────────── errored ───────────────────────────

describe("errored endings", () => {
	it("labels a session whose final generation failed", () => {
		const messages = [
			row({ role: "user", content_text: "Continue refactoring the parser module please." }),
			row({ role: "assistant", stop_reason: "error", error_message: "connection dropped mid-stream" }),
		];
		const scan = classifyEnding(messages, CONFIG);
		assert.equal(scan!.label, "errored");
		assert.equal(scan!.evidence.rule, "generation_failure_at_end");
	});

	it("labels a session that ends on an error-flagged tool result", () => {
		const messages = [
			row({ role: "user", content_text: "Run the deploy script again." }),
			row(shellCall("d1", "./deploy.sh")),
			row(shellResult("d1", true)),
		];
		const scan = classifyEnding(messages, CONFIG);
		assert.equal(scan!.label, "errored");
		assert.equal(scan!.evidence.rule, "failed_result_at_end");
	});
});

// ─────────────────────────── abandoned ───────────────────────────

describe("abandoned endings", () => {
	it("labels a session ending on an unanswered user message as abandoned", () => {
		const messages = [
			row({ role: "user", content_text: "Why is the migration script still failing on staging?" }),
			row({ role: "assistant", content_text: "Let me look into the staging logs right away." }),
			row({ role: "user", content_text: "Any news? The release window closes in ten minutes." }),
		];
		const scan = classifyEnding(messages, CONFIG);
		assert.equal(scan!.label, "abandoned");
		assert.equal(scan!.evidence.rule, "unanswered_user_message");
	});

	it("labels a transcript cut off mid-work (unanswered tool calls) as abandoned", () => {
		const messages = [
			row({ role: "user", content_text: "Refactor the whole auth module across these five files." }),
			row(shellCall("m1", "npm test")),
			row(shellResult("m1", false)),
			row({
				role: "assistant",
				tool_calls: JSON.stringify([{ id: "m2", name: "bash", arguments: { command: "git add -A && git commit" } }]),
				stop_reason: "toolUse",
			}),
		];
		const scan = classifyEnding(messages, CONFIG);
		assert.equal(scan!.label, "abandoned");
		assert.equal(scan!.evidence.rule, "cut_off_mid_work");
		assert.ok((scan!.unresolved_tool_call_count) >= 1, "the unanswered call is counted");
	});

	it("labels an operator abort of the final generation as abandoned, not errored", () => {
		const messages = [
			row({ role: "user", content_text: "Rewrite the docs folder." }),
			row({ role: "assistant", stop_reason: "aborted" }),
		];
		const scan = classifyEnding(messages, CONFIG);
		assert.equal(scan!.label, "abandoned");
		assert.equal(scan!.evidence.rule, "operator_abort_at_end");
	});

	it("labels a session ending on a successful result nobody synthesised as abandoned", () => {
		const messages = [
			row({ role: "user", content_text: "Summarise the lint output when it finishes." }),
			row(shellCall("s1", "npm test")),
			row(shellResult("s1", false)),
		];
		const scan = classifyEnding(messages, CONFIG);
		assert.equal(scan!.label, "abandoned");
		assert.equal(scan!.evidence.rule, "unanswered_result_at_end");
	});
});

// ─────────────────────────── handed-off ───────────────────────────

describe("handed-off endings", () => {
	it("labels a short explicit closing utterance as handed-off", () => {
		const messages = [
			row({ role: "user", content_text: "Fix the typo in the README heading." }),
			row({ role: "assistant", content_text: "Fixed and pushed the one-line change to the docs branch." }),
			row({ role: "user", content_text: "thanks, done" }),
		];
		const scan = classifyEnding(messages, CONFIG);
		assert.equal(scan!.label, "handed-off");
		assert.equal(scan!.evidence.rule, "explicit_closure");
	});

	it("does not mistake a long message starting with thanks for a sign-off", () => {
		const long = "thanks but actually while you are here could you also look at the flaky integration suite?";
		const messages = [
			row({ role: "user", content_text: "Check the pipeline." }),
			row({ role: "assistant", content_text: "The pipeline looks healthy from here, nothing failing." }),
			row({ role: "user", content_text: long }),
		];
		const scan = classifyEnding(messages, CONFIG);
		assert.equal(scan!.label, "abandoned", "over maxClosureLength, a cue word is not a closure");
	});
});

// ─────────────────────────── unclear (conservative default) ───────────────────────────

describe("unclear endings", () => {
	it("defaults a pure conversation with no tool evidence to unclear", () => {
		const messages = [
			row({ role: "user", content_text: "What does the standard library's sort guarantee about stability?" }),
			row({ role: "assistant", content_text: "It is stable since the 2.3 release; equal elements keep insertion order." }),
		];
		const scan = classifyEnding(messages, CONFIG);
		assert.equal(scan!.label, "unclear");
		assert.equal(scan!.evidence.rule, "no_outcome_evidence");
		assert.equal(scan!.tool_call_count, 0);
	});

	it("stays unclear when the agent wraps up right after a failing verification", () => {
		const messages = [
			row({ role: "user", content_text: "Try to make the legacy suite green today if possible." }),
			row(shellCall("f1", "npm test")),
			row(shellResult("f1", true)),
			row({
				role: "assistant",
				content_text: "Two tests still fail; both are known flakes tracked upstream, everything else passes.",
			}),
		];
		const scan = classifyEnding(messages, CONFIG);
		assert.equal(scan!.label, "unclear");
		assert.equal(scan!.evidence.rule, "wrap_up_after_failed_verification");
		assert.equal(scan!.evidence.verification_ok, false);
	});

	it("is unclear when a wrap-up follows a failed ordinary tool call", () => {
		const messages = [
			row({ role: "user", content_text: "Open the metrics dashboard config and adjust the interval." }),
			row({
				role: "assistant",
				tool_calls: JSON.stringify([{ name: "edit", arguments: { file_path: "/tmp/dash.yml" } }]),
				stop_reason: "toolUse",
			}),
			row({ id: "oo1", role: "toolResult", tool_results: JSON.stringify([{ toolName: "edit", isError: true, textLength: 3 }]) }),
			row({ role: "assistant", content_text: "The edit was refused by the guardrail; I stopped rather than force it through." }),
		];
		const scan = classifyEnding(messages, CONFIG);
		assert.equal(scan!.label, "unclear");
		assert.equal(scan!.evidence.rule, "summary_after_failure");
	});

	it("is unclear when the final assistant step carries too little text to be a summary", () => {
		const messages = [
			row({ role: "user", content_text: "Run the checks." }),
			row(shellCall("t1", "make test")),
			row(shellResult("t1", false)),
			row({ role: "assistant", content_text: "ok" }),
		];
		const scan = classifyEnding(messages, CONFIG);
		assert.equal(scan!.label, "unclear");
		assert.equal(scan!.evidence.rule, "insufficient_final_text");
	});

	it("is unclear when the transcript ends on a non-conversational row", () => {
		const messages = [
			row({ role: "user", content_text: "Long task, please continue." }),
			row({ role: "compactionSummary", content_text: "The task so far concerned refactoring the parser module." }),
		];
		const scan = classifyEnding(messages, CONFIG);
		assert.equal(scan!.label, "unclear");
		assert.equal(scan!.evidence.rule, "non_conversational_end");
	});
});

// ─────────────────────────── evidence & coverage ───────────────────────────

describe("evidence", () => {
	it("returns null only for an empty transcript", () => {
		assert.equal(classifyEnding([], CONFIG), null);
	});

	it("truncates the final-assistant excerpt to excerptLength", () => {
		const long = "x".repeat(500) + " the tail that must never survive truncation.";
		const messages = [
			row({ role: "user", content_text: "Do the thing." }),
			row({ role: "assistant", content_text: long }),
		];
		const scan = classifyEnding(messages, CONFIG);
		const excerpt = scan!.evidence.final_assistant_excerpt!;
		assert.equal(excerpt.length, CONFIG.excerptLength);
		assert.ok(!excerpt.includes("must never survive"));
	});

	it("reports whether any stop reason was recorded", () => {
		const without = [row({ role: "user", content_text: "hi there" }), row({ role: "assistant", content_text: "hello, happy to help with anything you need today" })];
		assert.equal(classifyEnding(without, CONFIG)!.stop_reason_recorded, false);
		const withStop = [row(shellCall("z1", "git status")), row(shellResult("z1", false)), row({ role: "assistant", stop_reason: "endTurn", content_text: "Everything is clean and committed on the feature branch already." })];
		assert.equal(classifyEnding(withStop, CONFIG)!.stop_reason_recorded, true);
	});
});
