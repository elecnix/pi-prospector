import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLine } from "../../src/sync/parser.js";

describe("parseLine", () => {
	it("parses a v3 session header", () => {
		const line = JSON.stringify({ type: "session", version: 3, id: "abc-123", timestamp: "2026-01-15T10:30:00.000Z", cwd: "/home/user/project" });
		const result = parseLine(line);
		assert.ok(result);
		assert.equal(result.kind, "session");
		if (result.kind === "session") {
			assert.equal(result.header.id, "abc-123");
			assert.equal(result.header.cwd, "/home/user/project");
		}
	});

	it("parses a session header with parentSession", () => {
		const line = JSON.stringify({ type: "session", version: 3, id: "def-456", timestamp: "2026-01-15T11:00:00.000Z", cwd: "/x", parentSession: "/path/to/parent.jsonl" });
		const result = parseLine(line);
		assert.ok(result);
		if (result.kind === "session") {
			assert.equal(result.header.parentSession, "/path/to/parent.jsonl");
		}
	});

	it("parses a user message with string content", () => {
		const line = JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-01-15T10:31:00Z", message: { role: "user", content: "Hello!", timestamp: 1000 } });
		const result = parseLine(line);
		assert.ok(result);
		assert.equal(result.kind, "message");
		if (result.kind === "message") {
			assert.equal(result.entry.role, "user");
			assert.equal(result.entry.text, "Hello!");
		}
	});

	it("parses a user message with content array", () => {
		const line = JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-15T10:32:00Z", message: { role: "user", content: [{ type: "text", text: "Look" }, { type: "image", data: "x", mimeType: "image/png" }], timestamp: 2000 } });
		const result = parseLine(line);
		assert.ok(result);
		if (result.kind === "message") {
			assert.equal(result.entry.text, "Look");
		}
	});

	it("parses assistant with thinking, text, and toolCall", () => {
		const line = JSON.stringify({ type: "message", id: "m3", parentId: "m2", timestamp: "2026-01-15T10:33:00Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "Hmm..." }, { type: "text", text: "Sure!" }, { type: "toolCall", id: "tc1", name: "read", arguments: { path: "/f.ts" } }], api: "anthropic", provider: "anthropic", model: "claude-sonnet-4-5", usage: {}, stopReason: "toolUse", timestamp: 3000 } });
		const result = parseLine(line);
		assert.ok(result);
		if (result.kind === "message") {
			assert.equal(result.entry.role, "assistant");
			assert.equal(result.entry.thinking, "Hmm...");
			assert.equal(result.entry.text, "Sure!");
			assert.ok(result.entry.tool_calls);
			assert.equal(result.entry.tool_calls![0]!.name, "read");
		}
	});

	it("parses a toolResult message", () => {
		const line = JSON.stringify({ type: "message", id: "m4", parentId: "m3", timestamp: "2026-01-15T10:34:00Z", message: { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 4000 } });
		const result = parseLine(line);
		assert.ok(result);
		if (result.kind === "message") {
			assert.equal(result.entry.role, "toolResult");
			assert.ok(result.entry.tool_results);
			assert.equal(result.entry.tool_results![0]!.toolName, "read");
			assert.equal(result.entry.tool_results![0]!.isError, false);
			assert.equal(result.entry.tool_results![0]!.textLength, 13);
		}
	});

	it("parses a compactionSummary entry", () => {
		const line = JSON.stringify({ type: "compactionSummary", id: "c1", parentId: "m4", timestamp: "2026-01-15T10:40:00Z", summary: "User asked about tests..." });
		const result = parseLine(line);
		assert.ok(result);
		if (result.kind === "message") {
			assert.equal(result.entry.role, "compactionSummary");
			assert.equal(result.entry.text, "User asked about tests...");
		}
	});

	it("parses a branch_summary entry (Pi's snake_case entry type)", () => {
		const line = JSON.stringify({ type: "branch_summary", id: "b1", parentId: "c1", timestamp: "2026-01-15T10:41:00Z", summary: "Branch context..." });
		const result = parseLine(line);
		assert.ok(result);
		if (result.kind === "message") {
			assert.equal(result.entry.role, "branch_summary");
		}
	});

	it("returns null for empty lines", () => {
		assert.equal(parseLine(""), null);
		assert.equal(parseLine("   "), null);
	});

	it("returns null for invalid JSON", () => {
		assert.equal(parseLine("not json"), null);
	});

	it("returns null for JSON without type", () => {
		assert.equal(parseLine(JSON.stringify({ id: "x" })), null);
	});

	// ── model & billed cost (issue #65) ──

	it("extracts model and billed cost from a Pi assistant message", () => {
		const line = JSON.stringify({
			type: "message",
			id: "m-cost",
			parentId: null,
			timestamp: "2026-01-15T10:33:00Z",
			message: {
				role: "assistant",
				content: "Sure!",
				model: "deepseek-v4-pro",
				usage: {
					input: 100,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 150,
					cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
				},
			},
		});
		const result = parseLine(line);
		assert.ok(result);
		assert.equal(result.kind, "message");
		if (result.kind === "message") {
			assert.equal(result.entry.model, "deepseek-v4-pro");
			assert.equal(result.entry.costUsd, 0.003);
			assert.ok(result.entry.usage);
			assert.equal(result.entry.usage!.input, 100);
		}
	});

	it("reads the Pi serving model from responseModel when model is absent", () => {
		const line = JSON.stringify({
			type: "message",
			id: "m-rsp",
			parentId: null,
			timestamp: "2026-01-15T10:33:00Z",
			message: { role: "assistant", content: "ok", responseModel: "gpt-5", usage: { input: 1, output: 1 } },
		});
		const result = parseLine(line);
		assert.ok(result && result.kind === "message");
		assert.equal(result.entry.model, "gpt-5");
	});

	it("collapses a zero Pi cost to null rather than a silent free (issue #65)", () => {
		// Pi defaults every cost bucket to 0 when a message is not priced, so a
		// recorded total of 0 must not read as "this was free".
		const line = JSON.stringify({
			type: "message",
			id: "m-zero",
			parentId: null,
			timestamp: "2026-01-15T10:33:00Z",
			message: { role: "assistant", content: "x", model: "m", usage: { input: 1, output: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
		});
		const result = parseLine(line);
		assert.ok(result && result.kind === "message");
		assert.equal(result.entry.costUsd, null);
		assert.equal(result.entry.model, "m");
	});

	it("leaves model and cost null on a Pi assistant message that records neither", () => {
		const line = JSON.stringify({
			type: "message",
			id: "m-none",
			parentId: null,
			timestamp: "2026-01-15T10:33:00Z",
			message: { role: "assistant", content: "x", usage: { input: 1, output: 1 } },
		});
		const result = parseLine(line);
		assert.ok(result && result.kind === "message");
		assert.equal(result.entry.model, null);
		assert.equal(result.entry.costUsd, null);
	});

	it("leaves model and cost null on non-assistant Pi messages", () => {
		const line = JSON.stringify({
			type: "message",
			id: "m-user",
			parentId: null,
			timestamp: "2026-01-15T10:33:00Z",
			message: { role: "user", content: "hi", model: "should-not-leak", usage: { input: 9 } },
		});
		const result = parseLine(line);
		assert.ok(result && result.kind === "message");
		assert.equal(result.entry.model, null);
		assert.equal(result.entry.costUsd, null);
		assert.equal(result.entry.usage, null);
	});
});