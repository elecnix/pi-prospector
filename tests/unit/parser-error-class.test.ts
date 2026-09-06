import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLine, classifyToolError } from "../../src/sync/parser.js";

/** Build a Pi toolResult line carrying the given error text. */
function errorLine(toolName: string, text: string, isError = true): string {
	return JSON.stringify({
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: "2026-01-15T10:34:00Z",
		message: { role: "toolResult", toolCallId: "tc1", toolName, content: [{ type: "text", text }], isError, timestamp: 4000 },
	});
}

function firstResult(line: string) {
	const parsed = parseLine(line);
	assert.ok(parsed);
	if (parsed.kind !== "message") return null;
	assert.ok(parsed.entry.tool_results);
	return parsed.entry.tool_results[0];
}

// Each pattern below was taken from a real failure in the corpus, not invented:
// 670 error results across 250 sessions, the edit family being the largest class.
describe("classifyToolError — edit anchors", () => {
	it("classifies the indexed form", () => {
		assert.equal(classifyToolError(true, "Could not find edits[0] in /a/b.ts"), "anchor_not_found");
	});
	it("classifies the exact-text form", () => {
		assert.equal(classifyToolError(true, "Could not find the exact text in /a/b.ts"), "anchor_not_found");
	});
	it("classifies overlapping edits separately, not as a missing anchor", () => {
		assert.equal(classifyToolError(true, "edits[0] and edits[1] overlap in /a/b.ts"), "edits_overlap");
	});
	it("classifies tool-argument validation", () => {
		assert.equal(classifyToolError(true, 'Validation failed for tool "edit":'), "input_invalid");
	});
});

describe("classifyToolError — shell and script", () => {
	it("classifies an unterminated quote", () => {
		assert.equal(classifyToolError(true, "bash: -c: line 1: unexpected EOF while looking for matching `'"), "shell_syntax");
	});
	it("classifies a python traceback", () => {
		assert.equal(classifyToolError(true, "Traceback (most recent call last):"), "script_error");
	});
	it("classifies a missing path", () => {
		assert.equal(classifyToolError(true, "cat: /nope: No such file or directory"), "not_found");
	});
	it("classifies a policy refusal ahead of any wording it quotes", () => {
		assert.equal(classifyToolError(true, "Blocked: sleep 30. A fixed `sleep` wastes time."), "policy_blocked");
	});
});

describe("classifyToolError — the two absences must differ", () => {
	it("returns undefined for a result that did not fail", () => {
		assert.equal(classifyToolError(false, "Could not find edits[0] in /a/b.ts"), undefined);
	});
	it("returns 'unclassified' for a failure it cannot name — never undefined", () => {
		assert.equal(classifyToolError(true, "something nobody has seen before"), "unclassified");
	});
	it("returns 'unclassified' for a failure with no text at all", () => {
		assert.equal(classifyToolError(true, null), "unclassified");
	});
});

describe("classifyToolError — wiring and privacy", () => {
	it("attaches errorClass to a failed tool result", () => {
		const r = firstResult(errorLine("edit", "Could not find edits[0] in /a/b.ts"));
		assert.equal(r?.errorClass, "anchor_not_found");
	});
	it("omits errorClass entirely on success, keeping rows byte-identical", () => {
		const r = firstResult(errorLine("edit", "ok", false));
		assert.equal(r?.errorClass, undefined);
		assert.ok(!Object.hasOwn(r as object, "errorClass"));
	});
	it("stores the class only — never the error text or a path from it", () => {
		const secret = "Could not find edits[0] in /Users/someone/private/keys.txt";
		const r = firstResult(errorLine("edit", secret));
		const serialised = JSON.stringify(r);
		assert.ok(!serialised.includes("private"), "result must not carry the path");
		assert.ok(!serialised.includes("keys.txt"), "result must not carry the filename");
		assert.equal(r?.textLength, secret.length, "only the length survives");
	});
});
