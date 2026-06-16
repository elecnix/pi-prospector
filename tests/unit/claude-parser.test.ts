import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLine, parseClaudeSessionMeta } from "../../src/sync/parser.js";

describe("parseLine (claude source)", () => {
	it("parses a Claude user message with string content", () => {
		const line = JSON.stringify({
			type: "user",
			uuid: "abc-123",
			parentUuid: "parent-456",
			sessionId: "sess-1",
			timestamp: "2026-01-15T10:30:00.000Z",
			message: { role: "user", content: "Hello, Claude!" },
		});
		const result = parseLine(line, "claude");
		assert.ok(result);
		assert.equal(result.kind, "message");
		if (result.kind === "message") {
			assert.equal(result.entry.role, "user");
			assert.equal(result.entry.id, "abc-123");
			assert.equal(result.entry.parentId, "parent-456");
			assert.equal(result.entry.text, "Hello, Claude!");
			assert.equal(result.entry.thinking, null);
		}
	});

	it("parses a Claude user message with tool_result content blocks", () => {
		const line = JSON.stringify({
			type: "user",
			uuid: "def-789",
			parentUuid: "abc-123",
			sessionId: "sess-1",
			timestamp: "2026-01-15T10:31:00.000Z",
			message: {
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "toolu_01", is_error: false, content: [{ type: "text", text: "file contents here" }] },
				],
			},
		});
		const result = parseLine(line, "claude");
		assert.ok(result);
		if (result.kind === "message") {
			assert.equal(result.entry.role, "toolResult");
			assert.equal(result.entry.id, "def-789");
			assert.equal(result.entry.text, "file contents here");
			assert.ok(result.entry.tool_results);
			assert.equal(result.entry.tool_results![0]!.toolCallId, "toolu_01");
			assert.equal(result.entry.tool_results![0]!.isError, false);
		}
	});

	it("parses a Claude user message with error tool_result", () => {
		const line = JSON.stringify({
			type: "user",
			uuid: "err-1",
			parentUuid: null,
			sessionId: "sess-1",
			message: {
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "toolu_err", is_error: true, content: "command not found" },
				],
			},
		});
		const result = parseLine(line, "claude");
		assert.ok(result);
		if (result.kind === "message") {
			assert.equal(result.entry.role, "toolResult");
			assert.ok(result.entry.tool_results);
			assert.equal(result.entry.tool_results![0]!.isError, true);
			assert.equal(result.entry.text, "command not found");
		}
	});

	it("parses a Claude assistant message with text", () => {
		const line = JSON.stringify({
			type: "assistant",
			uuid: "asst-1",
			parentUuid: "user-1",
			sessionId: "sess-1",
			timestamp: "2026-01-15T10:32:00.000Z",
			message: {
				role: "assistant",
				model: "claude-opus-4-8",
				usage: { input_tokens: 100, output_tokens: 50 },
				content: [{ type: "text", text: "I can help with that!" }],
			},
		});
		const result = parseLine(line, "claude");
		assert.ok(result);
		if (result.kind === "message") {
			assert.equal(result.entry.role, "assistant");
			assert.equal(result.entry.id, "asst-1");
			assert.equal(result.entry.text, "I can help with that!");
			assert.equal(result.entry.thinking, null);
		}
	});

	it("parses a Claude assistant message with thinking and tool_use", () => {
		const line = JSON.stringify({
			type: "assistant",
			uuid: "asst-2",
			parentUuid: "user-2",
			sessionId: "sess-1",
			timestamp: "2026-01-15T10:33:00.000Z",
			message: {
				role: "assistant",
				model: "claude-sonnet-4-5",
				content: [
					{ type: "thinking", thinking: "Let me think about this..." },
					{ type: "tool_use", id: "toolu_02", name: "read", input: { path: "/file.txt" } },
					{ type: "text", text: "I've read the file." },
				],
			},
		});
		const result = parseLine(line, "claude");
		assert.ok(result);
		if (result.kind === "message") {
			assert.equal(result.entry.role, "assistant");
			assert.equal(result.entry.thinking, "Let me think about this...");
			assert.equal(result.entry.text, "I've read the file.");
			assert.ok(result.entry.tool_calls);
			assert.equal(result.entry.tool_calls![0]!.name, "read");
			assert.deepEqual(result.entry.tool_calls![0]!.arguments, { path: "/file.txt" });
		}
	});

	it("ignores Claude metadata types (mode, permission-mode, attachment, system)", () => {
		const nonMessageTypes = [
			{ type: "mode", mode: "code", sessionId: "sess" },
			{ type: "permission-mode", permissionMode: "default", sessionId: "sess" },
			{ type: "attachment", parentUuid: "x", attachment: {}, uuid: "y" },
			{ type: "file-history-snapshot", messageId: "m1", snapshot: {} },
			{ type: "system", parentUuid: "x", subtype: "init" },
			{ type: "last-prompt", leafUuid: "z", sessionId: "sess" },
		];
		for (const obj of nonMessageTypes) {
			assert.equal(parseLine(JSON.stringify(obj), "claude"), null);
		}
	});

	it("extracts ai-title as a custom message", () => {
		const line = JSON.stringify({
			type: "ai-title",
			aiTitle: "Review dotfiles repo",
			sessionId: "sess-1",
		});
		const result = parseLine(line, "claude");
		assert.ok(result);
		if (result.kind === "message") {
			assert.equal(result.entry.role, "custom_message");
			assert.equal(result.entry.text, "__CLAUDE_TITLE__Review dotfiles repo");
		}
	});

	it("returns null for empty lines (claude)", () => {
		assert.equal(parseLine("", "claude"), null);
		assert.equal(parseLine("   ", "claude"), null);
	});

	it("returns null for invalid JSON (claude)", () => {
		assert.equal(parseLine("not json", "claude"), null);
	});
});

describe("parseClaudeSessionMeta", () => {
	it("extracts title and timestamp from session lines", () => {
		const lines = [
			JSON.stringify({ type: "last-prompt", leafUuid: "x", sessionId: "s1" }),
			JSON.stringify({ type: "ai-title", aiTitle: "My Session", sessionId: "s1" }),
			JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-01-15T10:30:00.000Z", message: { role: "user", content: "hi" } }),
		];
		const meta = parseClaudeSessionMeta(lines);
		assert.ok(meta);
		assert.equal(meta.title, "My Session");
		assert.equal(meta.timestamp, "2026-01-15T10:30:00.000Z");
	});

	it("returns null for empty lines array", () => {
		assert.equal(parseClaudeSessionMeta([]), null);
	});

	it("returns nulls when no metadata found", () => {
		const lines = [
			JSON.stringify({ type: "mode", mode: "code" }),
			JSON.stringify({ type: "permission-mode", permissionMode: "default" }),
		];
		const meta = parseClaudeSessionMeta(lines);
		assert.ok(meta);
		assert.equal(meta.title, null);
		assert.equal(meta.timestamp, null);
	});
});
