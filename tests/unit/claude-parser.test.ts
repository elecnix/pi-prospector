import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLine, parseClaudeSessionMeta, buildClaudeToolNameMap } from "../../src/sync/parser.js";

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

	it("leaves tool_result toolName empty when no name map is supplied (backward compat)", () => {
		const line = JSON.stringify({
			type: "user",
			uuid: "def-789",
			message: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "toolu_01", is_error: false, content: "x" }],
			},
		});
		const result = parseLine(line, "claude");
		assert.ok(result && result.kind === "message");
		assert.equal(result.entry.tool_results![0]!.toolName, "");
	});

	it("resolves tool_result toolName from a supplied tool_use_id → name map (issue #30)", () => {
		const line = JSON.stringify({
			type: "user",
			uuid: "def-789",
			message: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "toolu_42", is_error: false, content: "file contents" }],
			},
		});
		const names = new Map<string, string>([["toolu_42", "read"]]);
		const result = parseLine(line, "claude", names);
		assert.ok(result && result.kind === "message");
		assert.equal(result.entry.tool_results![0]!.toolName, "read");
		assert.equal(result.entry.tool_results![0]!.toolCallId, "toolu_42");
	});

	it("buildClaudeToolNameMap maps tool_use ids to normalized names across lines", () => {
		const lines = [
			JSON.stringify({
				type: "assistant",
				uuid: "a1",
				message: {
					role: "assistant",
					content: [
						{ type: "tool_use", id: "toolu_a", name: "Read", input: { path: "/f" } },
						{ type: "tool_use", id: "toolu_b", name: "Bash", input: { command: "ls" } },
					],
				},
			}),
			JSON.stringify({
				type: "assistant",
				uuid: "a2",
				message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_c", name: "Grep", input: { pattern: "x" } }] },
			}),
			// non-assistant / non-tool lines are ignored
			JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "hi" } }),
		];
		const map = buildClaudeToolNameMap(lines);
		assert.equal(map.get("toolu_a"), "read");
		assert.equal(map.get("toolu_b"), "bash");
		assert.equal(map.get("toolu_c"), "grep");
		assert.equal(map.size, 3);
	});

	it("end-to-end: a tool_result resolves to the name of its preceding tool_use", () => {
		const lines = [
			JSON.stringify({
				type: "assistant",
				uuid: "a1",
				message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_x", name: "Read", input: { path: "/big.ts" } }] },
			}),
			JSON.stringify({
				type: "user",
				uuid: "u1",
				message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x", is_error: false, content: "..." }] },
			}),
		];
		const map = buildClaudeToolNameMap(lines);
		const parsed = parseLine(lines[1]!, "claude", map);
		assert.ok(parsed && parsed.kind === "message");
		assert.equal(parsed.entry.tool_results![0]!.toolName, "read");
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

	it("skips ai-title (not inserted as a message)", () => {
		const line = JSON.stringify({
			type: "ai-title",
			aiTitle: "Review dotfiles repo",
			sessionId: "sess-1",
		});
		const result = parseLine(line, "claude");
		assert.equal(result, null);
	});

	it("skips ai-title type without aiTitle field", () => {
		const line = JSON.stringify({ type: "ai-title", sessionId: "sess-1" });
		assert.equal(parseLine(line, "claude"), null);
	});

	it("returns null for empty lines (claude)", () => {
		assert.equal(parseLine("", "claude"), null);
		assert.equal(parseLine("   ", "claude"), null);
	});

	it("returns null for invalid JSON (claude)", () => {
		assert.equal(parseLine("not json", "claude"), null);
	});

	it("skips user messages with isMeta flag", () => {
		const line = JSON.stringify({
			type: "user",
			uuid: "meta1",
			isMeta: true,
			message: { role: "user", content: "/model" },
		});
		assert.equal(parseLine(line, "claude"), null);
	});

	it("returns null for user message missing uuid", () => {
		const line = JSON.stringify({
			type: "user",
			message: { role: "user", content: "hello" },
		});
		assert.equal(parseLine(line, "claude"), null);
	});

	it("returns null for assistant message missing uuid", () => {
		const line = JSON.stringify({
			type: "assistant",
			message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
		});
		assert.equal(parseLine(line, "claude"), null);
	});

	it("normalizes Claude capitalized tool names to lowercase", () => {
		const line = JSON.stringify({
			type: "assistant",
			uuid: "asst-tools",
			message: {
				role: "assistant",
				content: [
					{ type: "tool_use", name: "Bash", input: { command: "ls" } },
					{ type: "tool_use", name: "Read", input: { path: "/f" } },
					{ type: "tool_use", name: "Write", input: { path: "/f", content: "x" } },
					{ type: "tool_use", name: "Edit", input: { path: "/f", oldText: "a", newText: "b" } },
					{ type: "tool_use", name: "Glob", input: { pattern: "*.ts" } },
					{ type: "tool_use", name: "Grep", input: { pattern: "foo" } },
				],
			},
		});
		const result = parseLine(line, "claude");
		assert.ok(result);
		if (result.kind === "message") {
			assert.ok(result.entry.tool_calls);
			assert.equal(result.entry.tool_calls![0]!.name, "bash");
			assert.equal(result.entry.tool_calls![1]!.name, "read");
			assert.equal(result.entry.tool_calls![2]!.name, "write");
			assert.equal(result.entry.tool_calls![3]!.name, "edit");
			assert.equal(result.entry.tool_calls![4]!.name, "glob");
			assert.equal(result.entry.tool_calls![5]!.name, "grep");
		}
	});

	it("passes through unknown tool names unchanged", () => {
		const line = JSON.stringify({
			type: "assistant",
			uuid: "asst-custom",
			message: {
				role: "assistant",
				content: [{ type: "tool_use", name: "CustomPlugin", input: {} }],
			},
		});
		const result = parseLine(line, "claude");
		assert.ok(result);
		if (result.kind === "message") {
			assert.equal(result.entry.tool_calls![0]!.name, "CustomPlugin");
		}
	});
});

describe("parseClaudeSessionMeta", () => {
	it("extracts title, timestamp, and cwd from session lines", () => {
		const lines = [
			JSON.stringify({ type: "last-prompt", leafUuid: "x", sessionId: "s1" }),
			JSON.stringify({ type: "ai-title", aiTitle: "My Session", sessionId: "s1" }),
			JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-01-15T10:30:00.000Z", cwd: "/home/user/project", message: { role: "user", content: "hi" } }),
		];
		const meta = parseClaudeSessionMeta(lines);
		assert.ok(meta);
		assert.equal(meta.title, "My Session");
		assert.equal(meta.timestamp, "2026-01-15T10:30:00.000Z");
		assert.equal(meta.cwd, "/home/user/project");
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
		assert.equal(meta.cwd, null);
	});
});
