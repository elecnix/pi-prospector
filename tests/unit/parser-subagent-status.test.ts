import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLine, ORCHESTRATION_TOOLS, SUBAGENT_EXCERPT_LIMIT } from "../../src/sync/parser.js";

/** Build a Pi toolResult line with the given tool name and result text. */
function toolResultLine(toolName: string, text: string): string {
	return JSON.stringify({
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: "2026-01-15T10:34:00Z",
		message: { role: "toolResult", toolCallId: "tc1", toolName, content: [{ type: "text", text }], isError: false, timestamp: 4000 },
	});
}

function parseToolResult(line: string) {
	const parsed = parseLine(line);
	assert.ok(parsed);
	assert.equal(parsed.kind, "message");
	if (parsed.kind !== "message") return null;
	assert.ok(parsed.entry.tool_results);
	assert.equal(parsed.entry.tool_results.length, 1);
	return parsed.entry.tool_results[0];
}

describe("ORCHESTRATION_TOOLS", () => {
	it("contains subagent", () => {
		assert.ok(ORCHESTRATION_TOOLS.includes("subagent"));
	});
});

describe("classifySubagentResult via parseLine — completed markers", () => {
	it("classifies 'Delivered single subagent result via intercom.' as completed", () => {
		const tr = parseToolResult(toolResultLine("subagent", "Delivered single subagent result via intercom."));
		assert.ok(tr?.subagent);
		assert.equal(tr.subagent.status, "completed");
		assert.equal(tr.subagent.failedChildren, undefined);
		assert.equal(tr.subagent.runId, undefined);
	});

	it("classifies 'Children: N completed' as completed (case-insensitive)", () => {
		const tr = parseToolResult(toolResultLine("subagent", "children: 3 COMPLETED"));
		assert.ok(tr?.subagent);
		assert.equal(tr.subagent.status, "completed");
	});

	it("leaves isError false even when children failed (tool call itself succeeded)", () => {
		const tr = parseToolResult(toolResultLine("subagent", "Children: 2 failed\n- worker [failed]: /tmp/out.md"));
		assert.ok(tr);
		assert.equal(tr.isError, false);
		assert.ok(tr.subagent);
	});
});

describe("classifySubagentResult via parseLine — child failure markers", () => {
	it("parses failedChildren from 'Children: N failed'", () => {
		const tr = parseToolResult(toolResultLine("subagent", "Children: 4 failed\n- worker [failed]: x"));
		assert.ok(tr?.subagent);
		assert.equal(tr.subagent.status, "child_failed");
		assert.equal(tr.subagent.failedChildren, 4);
	});

	it("classifies bare '[failed]:' as child_failed without a count", () => {
		const tr = parseToolResult(toolResultLine("subagent", "- worker [failed]: /tmp/output.md"));
		assert.ok(tr?.subagent);
		assert.equal(tr.subagent.status, "child_failed");
		assert.equal(tr.subagent.failedChildren, undefined);
	});
});

describe("classifySubagentResult via parseLine — revive markers", () => {
	it("extracts runId from 'Revived async subagent from <runId>.'", () => {
		const tr = parseToolResult(toolResultLine("subagent", "Revived async subagent from run-abc123.\nRevived run: run-def456"));
		assert.ok(tr?.subagent);
		assert.equal(tr.subagent.status, "revived");
		assert.equal(tr.subagent.runId, "run-abc123");
	});

	it("extracts runId from 'Revived foreground subagent from <runId>.'", () => {
		const tr = parseToolResult(toolResultLine("subagent", "Revived foreground subagent from fg-42."));
		assert.ok(tr?.subagent);
		assert.equal(tr.subagent.status, "revived");
		assert.equal(tr.subagent.runId, "fg-42");
	});
});

describe("excerpt bounding", () => {
	it("bounds the excerpt at 500 chars", () => {
		const long = "x".repeat(5000);
		const tr = parseToolResult(toolResultLine("subagent", `Delivered single subagent result via intercom.\n${long}`));
		assert.ok(tr?.subagent);
		assert.equal(tr.subagent.excerpt.length, SUBAGENT_EXCERPT_LIMIT);
		assert.ok(!tr.subagent.excerpt.includes("x".repeat(501)));
	});

	it("keeps short text whole", () => {
		const tr = parseToolResult(toolResultLine("subagent", "Delivered single subagent result via intercom."));
		assert.ok(tr?.subagent);
		assert.equal(tr.subagent.excerpt, "Delivered single subagent result via intercom.");
	});
});

describe("non-orchestration tools and unmarked text are unaffected", () => {
	it("does not classify a read result carrying the same markers", () => {
		const tr = parseToolResult(toolResultLine("read", "Children: 1 failed\n[failed]: nope"));
		assert.ok(tr);
		assert.equal(tr.subagent, undefined);
		assert.equal(tr.toolName, "read");
		assert.equal(tr.textLength, "Children: 1 failed\n[failed]: nope".length);
	});

	it("does not classify a subagent result without any marker", () => {
		const tr = parseToolResult(toolResultLine("subagent", "Worker finished with no status marker."));
		assert.ok(tr);
		assert.equal(tr.subagent, undefined);
	});
});

describe("DB round-trip safety", () => {
	it("survives JSON.stringify/parse like the sync layer's serialization", () => {
		const parsed = parseLine(toolResultLine("subagent", "Children: 2 failed\n- worker [failed]: x"));
		assert.ok(parsed && parsed.kind === "message" && parsed.entry.tool_results);
		const roundTripped = JSON.parse(JSON.stringify(parsed.entry.tool_results)) as typeof parsed.entry.tool_results;
		assert.ok(roundTripped[0]?.subagent);
		assert.equal(roundTripped[0].subagent.status, "child_failed");
		assert.equal(roundTripped[0].subagent.failedChildren, 2);
	});
});

describe("malformed input is safe", () => {
	it("returns null for malformed JSON instead of throwing", () => {
		assert.equal(parseLine("{not json"), null);
	});

	it("tolerates a toolResult with missing content", () => {
		const line = JSON.stringify({ type: "message", id: "m2", parentId: null, timestamp: "2026-01-15T10:35:00Z", message: { role: "toolResult", toolCallId: "tc2", toolName: "subagent", isError: false, timestamp: 5000 } });
		const tr = parseToolResult(line);
		assert.ok(tr);
		assert.equal(tr.textLength, 0);
		assert.equal(tr.subagent, undefined);
	});
});
