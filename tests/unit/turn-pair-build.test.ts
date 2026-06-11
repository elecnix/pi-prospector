import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTurnPairs } from "../../src/analyze/analyzers/turn-pair-core/build.js";
import type { MessageRow } from "../../src/analyze/types.js";

function msg(partial: Partial<MessageRow> & { id: string; role: string }): MessageRow {
	return {
		id: partial.id,
		session_id: "s1",
		parent_id: partial.parent_id ?? null,
		timestamp: partial.timestamp ?? null,
		role: partial.role,
		content_text: partial.content_text ?? null,
		content_thinking: partial.content_thinking ?? null,
		tool_calls: partial.tool_calls ?? null,
		tool_results: partial.tool_results ?? null,
	};
}

describe("buildTurnPairs", () => {
	it("groups a user message with following assistant/tool messages", () => {
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: "fix the bug" }),
			msg({ id: "a1", role: "assistant", content_text: "looking", tool_calls: JSON.stringify([{ name: "read" }]) }),
			msg({ id: "t1", role: "toolResult", tool_results: JSON.stringify([{ toolName: "read", isError: false, textLength: 100 }]) }),
			msg({ id: "a2", role: "assistant", content_text: "fixed it" }),
			msg({ id: "u2", role: "user", content_text: "now add tests" }),
			msg({ id: "a3", role: "assistant", content_text: "done" }),
		];
		const pairs = buildTurnPairs(messages);
		assert.equal(pairs.length, 2);

		const first = pairs[0]!;
		assert.equal(first.userMessageId, "u1");
		assert.deepEqual(first.messageIds, ["u1", "a1", "t1", "a2"]);
		assert.ok(first.assistantText.includes("looking") && first.assistantText.includes("fixed it"));
		assert.equal(first.toolCalls.length, 1);
		assert.equal(first.toolResults.length, 1);
		assert.equal(first.priorUserText, null);

		const second = pairs[1]!;
		assert.equal(second.userMessageId, "u2");
		assert.equal(second.priorUserText, "fix the bug");
	});

	it("ignores messages before the first user message", () => {
		const messages: MessageRow[] = [
			msg({ id: "c1", role: "compactionSummary", content_text: "summary" }),
			msg({ id: "u1", role: "user", content_text: "hi" }),
		];
		const pairs = buildTurnPairs(messages);
		assert.equal(pairs.length, 1);
		assert.deepEqual(pairs[0]!.messageIds, ["u1"]);
	});

	it("captures assistant thinking text", () => {
		const pairs = buildTurnPairs([
			msg({ id: "u1", role: "user", content_text: "q" }),
			msg({ id: "a1", role: "assistant", content_thinking: "hmm" }),
		]);
		assert.equal(pairs[0]!.thinkingText, "hmm");
	});

	it("tolerates malformed tool_calls/tool_results JSON", () => {
		const pairs = buildTurnPairs([
			msg({ id: "u1", role: "user", content_text: "q" }),
			msg({ id: "a1", role: "assistant", tool_calls: "{not json" }),
			msg({ id: "t1", role: "toolResult", tool_results: "also bad" }),
		]);
		assert.equal(pairs[0]!.toolCalls.length, 0);
		assert.equal(pairs[0]!.toolResults.length, 0);
	});

	it("returns empty for no messages", () => {
		assert.deepEqual(buildTurnPairs([]), []);
	});

	it("starts a new turn at a bashExecution entry", () => {
		const pairs = buildTurnPairs([
			msg({ id: "u1", role: "user", content_text: "do it" }),
			msg({ id: "a1", role: "assistant", content_text: "ok" }),
			msg({ id: "b1", role: "bashExecution", content_text: "npm test" }),
			msg({ id: "a2", role: "assistant", content_text: "green" }),
		]);
		assert.equal(pairs.length, 2);
		assert.deepEqual(pairs[0]!.messageIds, ["u1", "a1"]);
		assert.equal(pairs[1]!.userMessageId, "b1");
		assert.deepEqual(pairs[1]!.messageIds, ["b1", "a2"]);
	});

	it("starts new turns at branch_summary and custom_message entries", () => {
		const pairs = buildTurnPairs([
			msg({ id: "br", role: "branch_summary", content_text: "branched" }),
			msg({ id: "a0", role: "assistant", content_text: "resuming" }),
			msg({ id: "u1", role: "user", content_text: "continue" }),
			msg({ id: "a1", role: "assistant", content_text: "sure" }),
			msg({ id: "cm", role: "custom_message", content_text: "injected note" }),
			msg({ id: "a2", role: "assistant", content_text: "ack" }),
		]);
		assert.equal(pairs.length, 3);
		assert.deepEqual(pairs.map((p) => p.userMessageId), ["br", "u1", "cm"]);
		assert.deepEqual(pairs[0]!.messageIds, ["br", "a0"]);
		assert.deepEqual(pairs[2]!.messageIds, ["cm", "a2"]);
	});

	it("does not start a turn at a compaction summary", () => {
		const pairs = buildTurnPairs([
			msg({ id: "u1", role: "user", content_text: "q" }),
			msg({ id: "a1", role: "assistant", content_text: "a" }),
			msg({ id: "c1", role: "compactionSummary", content_text: "summary" }),
			msg({ id: "a2", role: "assistant", content_text: "more" }),
		]);
		// Single turn; the compaction summary is neither a turn start nor captured.
		assert.equal(pairs.length, 1);
		assert.deepEqual(pairs[0]!.messageIds, ["u1", "a1", "a2"]);
	});
});
