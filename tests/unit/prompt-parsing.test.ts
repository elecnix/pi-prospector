import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	extractJsonObject,
	parseClassifyObject,
	parseClassifyResponse,
	buildClassifyPrompt,
} from "../../src/analyze/analyzers/turn-pair-llm/prompt.js";
import { parseMapObject, parseMapResponse } from "../../src/analyze/analyzers/session-overview/prompt-map.js";
import { parseReduceObject, parseReduceResponse } from "../../src/analyze/analyzers/session-overview/prompt-reduce.js";

describe("extractJsonObject", () => {
	it("parses a bare JSON object", () => {
		assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
	});

	it("parses JSON inside markdown fences", () => {
		assert.deepEqual(extractJsonObject('```json\n{"a":2}\n```'), { a: 2 });
	});

	it("parses JSON surrounded by prose", () => {
		assert.deepEqual(extractJsonObject('Here you go: {"a":3} cheers'), { a: 3 });
	});

	it("handles nested objects", () => {
		assert.deepEqual(extractJsonObject('{"a":{"b":1}}'), { a: { b: 1 } });
	});

	it("throws when no object present", () => {
		assert.throws(() => extractJsonObject("no json here"), /No JSON object/);
	});

	it("throws on unterminated object", () => {
		assert.throws(() => extractJsonObject('{"a":1'), /Unterminated/);
	});
});

describe("parseClassifyResponse", () => {
	it("parses a valid classification", () => {
		const r = parseClassifyResponse('{"sentiment":"frustrated","friction_type":"wrong_approach","is_genuine_correction":true,"severity":"high","rationale":"x"}');
		assert.equal(r.sentiment, "frustrated");
		assert.equal(r.friction_type, "wrong_approach");
		assert.equal(r.is_genuine_correction, true);
		assert.equal(r.severity, "high");
	});

	it("falls back to safe defaults on invalid enum values", () => {
		const r = parseClassifyResponse('{"sentiment":"weird","friction_type":"nope","severity":"huge"}');
		assert.equal(r.sentiment, "neutral");
		assert.equal(r.friction_type, "none");
		assert.equal(r.severity, "low");
		assert.equal(r.is_genuine_correction, false);
	});

	it("normalises parsed tool-call objects the same way as text JSON", () => {
		const cases: Record<string, unknown>[] = [
			{ sentiment: "frustrated", friction_type: "tool_misuse", is_genuine_correction: true, severity: "high", rationale: "wrong flag" },
			{ sentiment: "positive", is_genuine_correction: false, rationale: "smooth" },
			{ sentiment: "weird", friction_type: "nope", is_genuine_correction: true, severity: "urgent", rationale: "invalid enums" },
			{},
		];
		for (const obj of cases) {
			assert.deepEqual(parseClassifyObject(obj), parseClassifyResponse(JSON.stringify(obj)));
		}
		assert.deepEqual(parseClassifyObject(cases[2]!), {
			sentiment: "neutral",
			friction_type: "none",
			is_genuine_correction: true,
			severity: "low",
			rationale: "invalid enums",
		});
		assert.deepEqual(parseClassifyObject(cases[3]!), {
			sentiment: "neutral",
			friction_type: "none",
			is_genuine_correction: false,
			severity: "low",
			rationale: "",
		});
	});
});

describe("buildClassifyPrompt", () => {
	it("includes user and assistant text and optional hint", () => {
		const p = buildClassifyPrompt({ userText: "hello", assistantText: "world", correctionText: "use X", toolCalls: [], toolResults: [] });
		assert.ok(p.includes("hello") && p.includes("world") && p.includes("use X"));
	});

	it("omits hint when absent", () => {
		const p = buildClassifyPrompt({ userText: "a", assistantText: "b", correctionText: null, toolCalls: [], toolResults: [] });
		assert.ok(!p.includes("HEURISTIC"));
	});

	it("includes tool calls section when tool calls have arguments", () => {
		const p = buildClassifyPrompt({
			userText: "push it",
			assistantText: "running git push",
			correctionText: null,
			toolCalls: [{ name: "bash", argumentsPreview: "git push -u origin v2nic/gh-pr-review" }],
			toolResults: [],
		});
		assert.ok(p.includes("TOOL CALLS:"), "prompt must include TOOL CALLS section");
		assert.ok(p.includes("bash:"), "prompt must mention tool name");
		assert.ok(p.includes("git push -u origin"), "prompt must include the arguments preview");
	});

	it("includes failing command for a tool-error turn", () => {
		const p = buildClassifyPrompt({
			userText: "YOU SHOULD HAVE PUSHED TO v2nic/gh-pr-review",
			assistantText: "creating PR",
			correctionText: null,
			toolCalls: [
				{ name: "bash", argumentsPreview: "git push -u origin v2nic/gh-pr-review" },
				{ name: "bash", argumentsPreview: "gh pr create --title fix" },
			],
			toolResults: [
				{ toolName: "bash", isError: true, errorHead: "Error: no --repo flag, targeting upstream" },
			],
		});
		assert.ok(p.includes("TOOL CALLS:"), "prompt must include TOOL CALLS section");
		assert.ok(p.includes("git push -u origin"), "prompt must include push command");
		assert.ok(p.includes("gh pr create"), "prompt must include gh command");
		assert.ok(p.includes("FAILED"), "prompt must mark failed result");
		assert.ok(p.includes("no --repo flag"), "prompt must include error head");
	});

	it("includes non-bash tool calls", () => {
		const p = buildClassifyPrompt({
			userText: "add the file",
			assistantText: "adding",
			correctionText: null,
			toolCalls: [{ name: "edit", argumentsPreview: "file=src/index.ts" }],
			toolResults: [],
		});
		assert.ok(p.includes("TOOL CALLS:"));
		assert.ok(p.includes("edit:"));
	});

	it("omits tool calls section when no tool calls and no errors", () => {
		const p = buildClassifyPrompt({ userText: "hi", assistantText: "hello", correctionText: null, toolCalls: [], toolResults: [] });
		assert.ok(!p.includes("TOOL CALLS:"));
	});

	it("shows tool calls section when there are errors even without tool calls", () => {
		const p = buildClassifyPrompt({
			userText: "run it",
			assistantText: "failed",
			correctionText: null,
			toolCalls: [],
			toolResults: [{ toolName: "bash", isError: true, errorHead: "command not found" }],
		});
		assert.ok(p.includes("TOOL CALLS:"));
		assert.ok(p.includes("FAILED"));
		assert.ok(p.includes("command not found"));
	});
});

describe("parseMapResponse", () => {
	it("parses segment summary and notable points", () => {
		const r = parseMapResponse('{"segment_summary":"s","notable_points":["a","b"]}', extractJsonObject);
		assert.equal(r.segment_summary, "s");
		assert.deepEqual(r.notable_points, ["a", "b"]);
	});

	it("defaults missing fields", () => {
		const r = parseMapResponse("{}", extractJsonObject);
		assert.equal(r.segment_summary, "");
		assert.deepEqual(r.notable_points, []);
	});

	it("normalises parsed tool-call objects the same way as text JSON", () => {
		const cases: Record<string, unknown>[] = [
			{ segment_summary: "segment ok", notable_points: ["a", "b"] },
			{ segment_summary: "partial" },
			{ segment_summary: 42, notable_points: ["keep", 1, null, "also keep"] },
			{},
		];
		for (const obj of cases) {
			assert.deepEqual(parseMapObject(obj), parseMapResponse(JSON.stringify(obj), extractJsonObject));
		}
		assert.deepEqual(parseMapObject(cases[2]!), {
			segment_summary: "",
			notable_points: ["keep", "also keep"],
		});
	});
});

describe("parseReduceResponse", () => {
	it("normalises parsed tool-call objects the same way as text JSON", () => {
		const cases: Record<string, unknown>[] = [
			{
				session_summary: "valid summary",
				friction_points: [{ description: "tool failed", what_to_change: "check flags", evidence: "turn 2", severity: "high" }],
				key_positive_signals: [{ description: "clean recovery", signal: "correction-then-clean-recovery" }],
				improvement_proposals: [{ title: "Document flags", summary: "Add flag guidance", severity: "correction" }],
			},
			{
				session_summary: "partial summary",
				friction_points: [{ description: "missing optional fields", severity: "medium" }],
				improvement_proposals: [{ title: "Partial proposal" }],
			},
			{
				session_summary: "invalid severities",
				friction_points: [{ description: "bad severity", what_to_change: "normalise", evidence: "unit", severity: "urgent" }],
				key_positive_signals: [{ description: "unknown signal", signal: "surprisingly-good" }],
				improvement_proposals: [{ title: "Bad severity", severity: "urgent" }, { title: "Keep good work", severity: "reinforcement" }],
			},
			{
				friction_points: [{ severity: "high" }, null, { description: "valid fallback", severity: "low" }],
				key_positive_signals: [{ signal: "low-tool-failure-density" }, 5],
				improvement_proposals: [null, "bad"],
			},
			{},
		];
		for (const obj of cases) {
			assert.deepEqual(parseReduceObject(obj), parseReduceResponse(JSON.stringify(obj), extractJsonObject));
		}
		const invalid = parseReduceObject(cases[2]!);
		assert.equal(invalid.friction_points[0]!.severity, "low");
		assert.equal(invalid.key_positive_signals[0]!.signal, "");
		assert.equal(invalid.improvement_proposals[0]!["severity"], "suggestion");
		assert.equal(invalid.improvement_proposals[1]!["severity"], "reinforcement");
		const missing = parseReduceObject(cases[3]!);
		assert.equal(missing.session_summary, "");
		assert.deepEqual(missing.friction_points, [{ description: "valid fallback", what_to_change: "", evidence: "", severity: "low" }]);
		assert.deepEqual(missing.key_positive_signals, []);
		assert.deepEqual(missing.improvement_proposals, []);
	});

	it("parses summary, friction points (enumerate-then-propose shape), positive signals, and proposals", () => {
		const json = JSON.stringify({
			session_summary: "did stuff",
			friction_points: [
				{ description: "x", what_to_change: "change X", evidence: "turn 3", severity: "high" },
				{ bad: true },
			],
			key_positive_signals: [
				{ description: "agent recovered well after a correction", signal: "correction-then-clean-recovery" },
			],
			improvement_proposals: [
				{ title: "t", summary: "s", target_type: "config", severity: "friction" },
				{ title: "Keep recovery", summary: "encode recovery", target_type: "agents_md", severity: "reinforcement" },
			],
		});
		const r = parseReduceResponse(json, extractJsonObject);
		assert.equal(r.session_summary, "did stuff");
		assert.equal(r.friction_points.length, 1);
		assert.equal(r.friction_points[0]!.description, "x");
		assert.equal(r.friction_points[0]!.what_to_change, "change X");
		assert.equal(r.friction_points[0]!.evidence, "turn 3");
		assert.equal(r.friction_points[0]!.severity, "high");
		assert.equal(r.key_positive_signals.length, 1);
		assert.equal(r.key_positive_signals[0]!.signal, "correction-then-clean-recovery");
		assert.equal(r.improvement_proposals.length, 2);
		assert.equal(r.improvement_proposals[1]!["severity"], "reinforcement");
	});

	it("defaults what_to_change and evidence to empty string when absent", () => {
		const json = JSON.stringify({
			session_summary: "s",
			friction_points: [{ description: "d", severity: "medium" }],
			improvement_proposals: [],
		});
		const r = parseReduceResponse(json, extractJsonObject);
		assert.equal(r.friction_points[0]!.what_to_change, "");
		assert.equal(r.friction_points[0]!.evidence, "");
		assert.equal(r.friction_points[0]!.severity, "medium");
	});

	it("defaults arrays when missing", () => {
		const r = parseReduceResponse("{}", extractJsonObject);
		assert.deepEqual(r.friction_points, []);
		assert.deepEqual(r.key_positive_signals, []);
		assert.deepEqual(r.improvement_proposals, []);
	});

	it("filters out invalid positive signals", () => {
		const json = JSON.stringify({
			session_summary: "test",
			friction_points: [],
			key_positive_signals: [
				{ description: "valid", signal: "task-completed-without-correction" },
				{ bad: true },
				5,
			],
			improvement_proposals: [],
		});
		const r = parseReduceResponse(json, extractJsonObject);
		assert.equal(r.key_positive_signals.length, 1);
		assert.equal(r.key_positive_signals[0]!.description, "valid");
	});

	it("falls back friction severity to 'low' for invalid values", () => {
		const json = JSON.stringify({
			session_summary: "s",
			friction_points: [{ description: "d", severity: "huge" }],
			improvement_proposals: [],
		});
		const r = parseReduceResponse(json, extractJsonObject);
		assert.equal(r.friction_points[0]!.severity, "low");
	});

	it("rejects friction point entries missing a description", () => {
		const json = JSON.stringify({
			session_summary: "s",
			friction_points: [{ severity: "high" }, null, { description: "valid", what_to_change: "c", evidence: "e", severity: "low" }],
			improvement_proposals: [],
		});
		const r = parseReduceResponse(json, extractJsonObject);
		assert.equal(r.friction_points.length, 1);
		assert.equal(r.friction_points[0]!.description, "valid");
	});

	it("falls back proposal severity to suggestion but preserves reinforcement", () => {
		const json = JSON.stringify({
			session_summary: "s",
			friction_points: [],
			key_positive_signals: [],
			improvement_proposals: [
				{ title: "bad", summary: "bad", severity: "urgent" },
				{ title: "reinforce", summary: "keep it", severity: "reinforcement" },
			],
		});
		const r = parseReduceResponse(json, extractJsonObject);
		assert.equal(r.improvement_proposals[0]!["severity"], "suggestion");
		assert.equal(r.improvement_proposals[1]!["severity"], "reinforcement");
	});
});
