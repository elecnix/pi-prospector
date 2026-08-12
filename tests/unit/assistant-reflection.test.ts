/**
 * Unit tests for the pure functions of the `assistant-reflection` custom analyzer.
 * No DB, no LLM — pure functions only (per AGENTS.md: mock nothing).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildClassifyPrompt,
	parseReflection,
	parseAbstention,
	CLASSIFY_PROMPT,
	CLASSIFY_SCHEMA,
	CLASSIFY_SCHEMA_RETRY,
	CLASSIFY_RESPONSE_SCHEMA,
	CLASSIFY_RESPONSE_SCHEMA_RETRY,
	RETRY_PROMPT,
	truncateHeadTail,
	type AssistantReflectionProperties,
} from "../../.prospector/analyzers/assistant-reflection.analyzer.js";

describe("assistant-reflection: buildClassifyPrompt", () => {
	it("renders thinking and response with labels", () => {
		const p = buildClassifyPrompt({ thinkingText: "I should check the worktree first.", assistantText: "Let me verify the path." });
		assert.ok(p.includes("THINKING:"));
		assert.ok(p.includes("I should check the worktree first."));
		assert.ok(p.includes("RESPONSE:"));
		assert.ok(p.includes("Let me verify the path."));
	});

	it("truncates very long text with head+tail", () => {
		const long = "x".repeat(5000);
		const p = buildClassifyPrompt({ thinkingText: long, assistantText: long });
		assert.ok(!p.includes("x".repeat(2400)), "no unbroken 2400-char run");
		assert.ok(p.includes("…"), "has gap marker");
		assert.ok(p.includes("chars omitted"), "has omission marker");
	});

	it("does not truncate short text", () => {
		const p = buildClassifyPrompt({ thinkingText: "short", assistantText: "also short" });
		assert.ok(!p.includes("…"));
	});
});

describe("assistant-reflection: truncateHeadTail", () => {
	it("returns short strings unchanged", () => {
		assert.equal(truncateHeadTail("hello", 100), "hello");
	});

	it("splits long strings with head and tail", () => {
		const s = "A".repeat(1000);
		const result = truncateHeadTail(s, 100);
		assert.ok(result.startsWith("A"));
		assert.ok(result.endsWith("A"));
		assert.ok(result.includes("chars omitted"));
	});
});

describe("assistant-reflection: parseReflection (memories)", () => {
	it("parses a valid memory with global scope", () => {
		const v = parseReflection({
			memories: [{ candidate_text: "User prefers tabs over spaces", scope: "global", confidence: 0.8, rationale: "stated in thinking" }],
			mistakes: [],
			user_frustration: [],
			user_acceptance: [],
		});
		assert.ok(v);
		assert.equal(v!.memories.length, 1);
		assert.equal(v!.memories[0]!.scope, "global");
		assert.equal(v!.memories[0]!.candidate_text, "User prefers tabs over spaces");
		assert.equal(v!.memories[0]!.confidence, 0.8);
	});

	it("parses a valid memory with project scope", () => {
		const v = parseReflection({
			memories: [{ candidate_text: "Project uses vitest", scope: "project", confidence: 0.6, rationale: "convention" }],
			mistakes: [],
			user_frustration: [],
			user_acceptance: [],
		});
		assert.ok(v);
		assert.equal(v!.memories[0]!.scope, "project");
	});

	it("rejects invalid scope", () => {
		const v = parseReflection({
			memories: [{ candidate_text: "test", scope: "invalid", confidence: 0.5, rationale: "r" }],
			mistakes: [],
			user_frustration: [],
			user_acceptance: [],
		});
		assert.equal(v, null);
	});

	it("rejects empty candidate_text", () => {
		const v = parseReflection({
			memories: [{ candidate_text: "", scope: "global", confidence: 0.5, rationale: "r" }],
			mistakes: [],
			user_frustration: [],
			user_acceptance: [],
		});
		assert.equal(v, null);
	});

	it("clamps confidence to 0-1", () => {
		const v = parseReflection({
			memories: [{ candidate_text: "test", scope: "global", confidence: 1.5, rationale: "r" }],
			mistakes: [],
			user_frustration: [],
			user_acceptance: [],
		});
		assert.ok(v);
		assert.equal(v!.memories[0]!.confidence, 1);
	});

	it("truncates candidate_text to 500 chars", () => {
		const long = "x".repeat(600);
		const v = parseReflection({
			memories: [{ candidate_text: long, scope: "global", confidence: 0.5, rationale: "r" }],
			mistakes: [],
			user_frustration: [],
			user_acceptance: [],
		});
		assert.ok(v);
		assert.equal(v!.memories[0]!.candidate_text.length, 500);
	});
});

describe("assistant-reflection: parseReflection (mistakes)", () => {
	it("parses a valid mistake with severity", () => {
		const v = parseReflection({
			memories: [],
			mistakes: [{ quote: "I should have known that", severity: "large", rationale: "missed instruction" }],
			user_frustration: [],
			user_acceptance: [],
		}, "I should have known that the user prefers tabs");
		assert.ok(v);
		assert.equal(v!.mistakes.length, 1);
		assert.equal(v!.mistakes[0]!.severity, "large");
		assert.equal(v!.mistakes[0]!.quote, "I should have known that");
	});

	it("rejects invalid severity", () => {
		const v = parseReflection({
			memories: [],
			mistakes: [{ quote: "oops", severity: "critical", rationale: "r" }],
			user_frustration: [],
			user_acceptance: [],
		}, "oops");
		assert.equal(v, null);
	});

	it("rejects empty quote", () => {
		const v = parseReflection({
			memories: [],
			mistakes: [{ quote: "", severity: "small", rationale: "r" }],
			user_frustration: [],
			user_acceptance: [],
		});
		assert.equal(v, null);
	});

	it("skips mistake with quote not in visible text", () => {
		const v = parseReflection({
			memories: [],
			mistakes: [
				{ quote: "fabricated quote", severity: "small", rationale: "r" },
				{ quote: "real quote", severity: "large", rationale: "r" },
			],
			user_frustration: [],
			user_acceptance: [],
		}, "this text contains a real quote somewhere");
		assert.ok(v);
		assert.equal(v!.mistakes.length, 1);
		assert.equal(v!.mistakes[0]!.quote, "real quote");
	});

	it("skips quote validation when visibleText is undefined", () => {
		const v = parseReflection({
			memories: [],
			mistakes: [{ quote: "any quote", severity: "small", rationale: "r" }],
			user_frustration: [],
			user_acceptance: [],
		});
		assert.ok(v);
		assert.equal(v!.mistakes.length, 1);
	});

	it("truncates quote to 300 chars", () => {
		const long = "x".repeat(400);
		const v = parseReflection({
			memories: [],
			mistakes: [{ quote: long, severity: "small", rationale: "r" }],
			user_frustration: [],
			user_acceptance: [],
		}, long);
		assert.ok(v);
		assert.equal(v!.mistakes[0]!.quote.length, 300);
	});
});

describe("assistant-reflection: parseReflection (user_frustration)", () => {
	it("parses a valid frustration with level", () => {
		const v = parseReflection({
			memories: [],
			mistakes: [],
			user_frustration: [{ level: "moderate", rationale: "user seems annoyed" }],
			user_acceptance: [],
		});
		assert.ok(v);
		assert.equal(v!.user_frustration.length, 1);
		assert.equal(v!.user_frustration[0]!.level, "moderate");
	});

	it("rejects invalid level", () => {
		const v = parseReflection({
			memories: [],
			mistakes: [],
			user_frustration: [{ level: "extreme", rationale: "r" }],
			user_acceptance: [],
		});
		assert.equal(v, null);
	});
});

describe("assistant-reflection: parseReflection (user_acceptance)", () => {
	it("parses a valid acceptance with level", () => {
		const v = parseReflection({
			memories: [],
			mistakes: [],
			user_frustration: [],
			user_acceptance: [{ level: "high", rationale: "user loves it" }],
		});
		assert.ok(v);
		assert.equal(v!.user_acceptance.length, 1);
		assert.equal(v!.user_acceptance[0]!.level, "high");
	});

	it("rejects invalid level", () => {
		const v = parseReflection({
			memories: [],
			mistakes: [],
			user_frustration: [],
			user_acceptance: [{ level: "ecstatic", rationale: "r" }],
		});
		assert.equal(v, null);
	});
});

describe("assistant-reflection: parseReflection (structural validation)", () => {
	it("rejects all-empty verdict (no signal)", () => {
		const v = parseReflection({
			memories: [],
			mistakes: [],
			user_frustration: [],
			user_acceptance: [],
		});
		assert.equal(v, null);
	});

	it("accepts a verdict with only memories", () => {
		const v = parseReflection({
			memories: [{ candidate_text: "test", scope: "global", confidence: 0.5, rationale: "r" }],
			mistakes: [],
			user_frustration: [],
			user_acceptance: [],
		});
		assert.ok(v);
		assert.equal(v!.memories.length, 1);
	});

	it("accepts a verdict with only user_frustration", () => {
		const v = parseReflection({
			memories: [],
			mistakes: [],
			user_frustration: [{ level: "mild", rationale: "r" }],
			user_acceptance: [],
		});
		assert.ok(v);
		assert.equal(v!.user_frustration.length, 1);
	});

	it("rejects when arrays are not arrays", () => {
		const v = parseReflection({
			memories: "not an array",
			mistakes: [],
			user_frustration: [],
			user_acceptance: [],
		});
		assert.equal(v, null);
	});
});

describe("assistant-reflection: parseAbstention", () => {
	it("parses a valid abstention", () => {
		const ab = parseAbstention({
			classifier_abstention: { reason: "thinking is empty", proposed_class: "other" },
		});
		assert.ok(ab);
		assert.equal(ab!.reason, "thinking is empty");
		assert.equal(ab!.proposed_class, "other");
	});

	it("rejects missing reason", () => {
		const ab = parseAbstention({
			classifier_abstention: { proposed_class: "other" },
		});
		assert.equal(ab, null);
	});

	it("rejects invalid proposed_class", () => {
		const ab = parseAbstention({
			classifier_abstention: { reason: "test", proposed_class: "unknown" },
		});
		assert.equal(ab, null);
	});

	it("rejects null abstention", () => {
		const ab = parseAbstention({
			classifier_abstention: null,
		});
		assert.equal(ab, null);
	});
});

describe("assistant-reflection: prompt content", () => {
	it("CLASSIFY_PROMPT mentions all four signal types", () => {
		assert.ok(CLASSIFY_PROMPT.includes("MEMORIES"));
		assert.ok(CLASSIFY_PROMPT.includes("MISTAKES"));
		assert.ok(CLASSIFY_PROMPT.includes("USER_FRUSTRATION"));
		assert.ok(CLASSIFY_PROMPT.includes("USER_ACCEPTANCE"));
	});

	it("CLASSIFY_PROMPT includes good/bad memory taxonomy", () => {
		assert.ok(CLASSIFY_PROMPT.includes("stable user preferences"));
		assert.ok(CLASSIFY_PROMPT.includes("secrets or credentials"));
	});

	it("CLASSIFY_PROMPT mentions severity levels", () => {
		assert.ok(CLASSIFY_PROMPT.includes("small"));
		assert.ok(CLASSIFY_PROMPT.includes("large"));
		assert.ok(CLASSIFY_PROMPT.includes("huge"));
	});

	it("CLASSIFY_PROMPT mentions frustration/acceptance levels", () => {
		assert.ok(CLASSIFY_PROMPT.includes("mild"));
		assert.ok(CLASSIFY_PROMPT.includes("moderate"));
		assert.ok(CLASSIFY_PROMPT.includes("high"));
	});

	it("RETRY_PROMPT mentions all four classes", () => {
		assert.ok(RETRY_PROMPT.includes("memories"));
		assert.ok(RETRY_PROMPT.includes("mistakes"));
		assert.ok(RETRY_PROMPT.includes("user_frustration"));
		assert.ok(RETRY_PROMPT.includes("user_acceptance"));
	});

	it("RETRY_PROMPT mentions abstention escape", () => {
		assert.ok(RETRY_PROMPT.includes("classifier_abstention"));
	});
});

describe("assistant-reflection: schema structure", () => {
	it("CLASSIFY_SCHEMA has the four arrays", () => {
		assert.ok("memories" in CLASSIFY_SCHEMA.properties);
		assert.ok("mistakes" in CLASSIFY_SCHEMA.properties);
		assert.ok("user_frustration" in CLASSIFY_SCHEMA.properties);
		assert.ok("user_acceptance" in CLASSIFY_SCHEMA.properties);
	});

	it("CLASSIFY_SCHEMA_RETRY has classifier_abstention", () => {
		assert.ok("classifier_abstention" in CLASSIFY_SCHEMA_RETRY.properties);
	});

	it("CLASSIFY_RESPONSE_SCHEMA has correct name", () => {
		assert.equal(CLASSIFY_RESPONSE_SCHEMA.name, "classify_reflection");
	});

	it("CLASSIFY_RESPONSE_SCHEMA_RETRY has correct name", () => {
		assert.equal(CLASSIFY_RESPONSE_SCHEMA_RETRY.name, "classify_reflection_retry");
	});
});