/**
 * PiRpcSource frame mapping — pure unit tests over the RPC event-stream parser.
 *
 * A pi-rpc transcript (out.jsonl) is an RPC/UI frame stream, not a session log:
 * it opens with an extension_ui_request instead of a session header, so the
 * ordinary Pi parser rejects it. These tests pin which frames become message
 * rows (message_end only) and which are pure transport.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRpcFrame } from "../../src/sync/sources/pi-rpc-parser.js";

const CTX = { dirName: "agent-alpha", lineNo: 7 };

describe("parseRpcFrame", () => {
	it("maps a user message_end onto a message row", () => {
		const line = JSON.stringify({
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: "run the deploy" }], timestamp: 1787594580235 },
		});
		const m = parseRpcFrame(line, CTX);
		assert.ok(m);
		assert.equal(m.id, "pi-rpc:agent-alpha:L7");
		assert.equal(m.role, "user");
		assert.equal(m.content_text, "run the deploy");
		assert.equal(m.timestamp, "2026-08-24T18:03:00.235Z");
		assert.equal(m.content_thinking, null);
		assert.equal(m.tool_calls, null);
		assert.equal(m.tool_results, null);
	});

	it("maps an assistant message_end with thinking, text and tool calls", () => {
		const line = JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "plan first" },
					{ type: "text", text: "doing it" },
					{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "/tmp/draft.md" } },
				],
				model: "ollama/deepseek-v4:0731-cloud",
				usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "toolUse",
				timestamp: 1787594580361,
			},
		});
		const m = parseRpcFrame(line, CTX);
		assert.ok(m);
		assert.equal(m.role, "assistant");
		assert.equal(m.content_thinking, "plan first");
		assert.equal(m.content_text, "doing it");
		assert.deepEqual(JSON.parse(m.tool_calls!), [{ id: "call_1", name: "read", arguments: { path: "/tmp/draft.md" } }]);
		assert.equal(m.model, "ollama/deepseek-v4:0731-cloud");
		assert.ok(m.usage);
		assert.equal(m.stop_reason, "toolUse");
		// A recorded zero total is a host-reported zero, not free money: null.
		assert.equal(m.cost_usd, null);
	});

	it("maps a toolResult message_end with the result shape the analyzers key off", () => {
		const line = JSON.stringify({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "read",
				content: [{ type: "text", text: "file body" }],
				isError: false,
				timestamp: 1787594580900,
			},
		});
		const m = parseRpcFrame(line, CTX);
		assert.ok(m);
		assert.equal(m.role, "toolResult");
		assert.deepEqual(JSON.parse(m.tool_results!), [{ toolCallId: "call_1", toolName: "read", isError: false, textLength: 9 }]);
		assert.equal(m.content_text, null);
	});

	it("classifies an orchestration toolResult like the Pi parser does", () => {
		const line = JSON.stringify({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "call_2",
				toolName: "subagent",
				content: [{ type: "text", text: "Children: 2 failed\n[failed]: run-a" }],
				isError: false,
			},
		});
		const m = parseRpcFrame(line, CTX);
		assert.ok(m);
		assert.ok(m.tool_results);
		const results = JSON.parse(m.tool_results!) as Array<{ subagent?: { status: string; failedChildren?: number } }>;
		assert.equal(results[0]!.subagent?.status, "child_failed");
		assert.equal(results[0]!.subagent?.failedChildren, 2);
	});

	it("drops transport and lifecycle frames: extension_ui_request, response, turn, tool_execution, agent, message_start, message_update", () => {
		const frames = [
			JSON.stringify({ type: "extension_ui_request", id: "x", method: "setWidget", widgetKey: "subagent-async" }),
			JSON.stringify({ type: "response", id: "r", command: "get_state", success: true, data: {} }),
			JSON.stringify({ type: "turn_start" }),
			JSON.stringify({ type: "turn_end" }),
			JSON.stringify({ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: {} }),
			JSON.stringify({ type: "tool_execution_end", toolCallId: "c", toolName: "bash", result: {}, isError: false }),
			JSON.stringify({ type: "tool_execution_update", toolCallId: "c", toolName: "bash", partial: {} }),
			JSON.stringify({ type: "agent_start" }),
			JSON.stringify({ type: "agent_end" }),
			JSON.stringify({ type: "agent_settled" }),
			JSON.stringify({ type: "queue_update" }),
			JSON.stringify({ type: "session_info_changed", name: "agent: task" }),
			JSON.stringify({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "429" }),
			JSON.stringify({ type: "auto_retry_end" }),
			JSON.stringify({ type: "extension_error", message: "boom" }),
			JSON.stringify({ type: "entry_appended" }),
			JSON.stringify({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "partial" }], timestamp: 1 } }),
			JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } }),
			// Extension plumbing with no conversational content: dropped.
			JSON.stringify({ type: "message_end", message: { role: "custom", customType: "job-finished", content: [{ type: "text", text: "done" }], timestamp: 1 } }),
			JSON.stringify({ type: "message_end", message: { role: "custom", customType: "bg-monitor-event", content: [{ type: "text", text: "tick" }], timestamp: 1 } }),
			JSON.stringify({ type: "message_end", message: { role: "custom", customType: "task-notification", content: [{ type: "text", text: "done" }], timestamp: 1 } }),
		];
		for (const line of frames) {
			assert.equal(parseRpcFrame(line, CTX), null, `expected drop: ${line.slice(0, 60)}`);
		}
	});

	it("keeps a custom message whose customType records what the fleet did, with its role verbatim", () => {
		const line = JSON.stringify({
			type: "message_end",
			message: { role: "custom", customType: "subagent-notify", content: [{ type: "text", text: "run finished" }], timestamp: 1787594590000 },
		});
		const m = parseRpcFrame(line, CTX);
		assert.ok(m);
		assert.equal(m.role, "custom");
		assert.equal(m.content_text, "run finished");
	});

	it("is deterministic: the same line number yields the same message id", () => {
		const line = JSON.stringify({ type: "message_end", message: { role: "user", content: "hi", timestamp: 1 } });
		assert.equal(parseRpcFrame(line, { dirName: "d", lineNo: 42 })!.id, parseRpcFrame(line, { dirName: "d", lineNo: 42 })!.id);
		assert.notEqual(parseRpcFrame(line, { dirName: "d", lineNo: 42 })!.id, parseRpcFrame(line, { dirName: "d", lineNo: 43 })!.id);
	});

	it("returns null for malformed JSON and for a message_end without a message", () => {
		assert.equal(parseRpcFrame("not json", CTX), null);
		assert.equal(parseRpcFrame(JSON.stringify({ type: "message_end" }), CTX), null);
	});
});
