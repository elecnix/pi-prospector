import { test } from "node:test";
import assert from "node:assert/strict";
import {
	scoreReplay,
	type ReplayTurnResult,
} from "../../src/analyze/analyzers/proposal-validate/index.js";
import { composeRuleText, buildWithRulePrompt, buildBaselinePrompt } from "../../src/analyze/analyzers/proposal-validate/prompt.js";

function turn(id: string, baseline: string, withRule: string): ReplayTurnResult {
	return {
		message_id: id,
		baseline_friction: baseline,
		with_rule_friction: withRule,
		averted: baseline !== "none" && withRule === "none",
	};
}

test("scoreReplay: no replay turns → unvalidated, null score", () => {
	const c = scoreReplay("ik", "m", [], 0.5);
	assert.equal(c.validation_status, "unvalidated");
	assert.equal(c.validated_score, null);
	assert.equal(c.baseline_friction_turns, 0);
});

test("scoreReplay: baseline shows no friction → unsupported, score 0", () => {
	// The validator could not reproduce any friction, so the rule cannot be credited.
	const c = scoreReplay("ik", "m", [turn("a", "none", "none"), turn("b", "none", "none")], 0.5);
	assert.equal(c.validation_status, "unsupported");
	assert.equal(c.validated_score, 0);
	assert.equal(c.baseline_friction_turns, 0);
});

test("scoreReplay: rule averts all friction → supported, score 1", () => {
	const c = scoreReplay("ik", "m", [turn("a", "wrong_approach", "none"), turn("b", "tool_misuse", "none")], 0.5);
	assert.equal(c.validation_status, "supported");
	assert.equal(c.validated_score, 1);
	assert.equal(c.averted_turns, 2);
	assert.equal(c.baseline_friction_turns, 2);
});

test("scoreReplay: rule averts none → unsupported, score 0 (the misattribution case)", () => {
	const c = scoreReplay("ik", "m", [turn("a", "wrong_approach", "wrong_approach")], 0.5);
	assert.equal(c.validation_status, "unsupported");
	assert.equal(c.validated_score, 0);
});

test("scoreReplay: partial aversion respects the support threshold", () => {
	const turns = [turn("a", "wrong_approach", "none"), turn("b", "wrong_approach", "wrong_approach")];
	// 1 of 2 friction turns averted = 0.5
	assert.equal(scoreReplay("ik", "m", turns, 0.5).validation_status, "supported");
	assert.equal(scoreReplay("ik", "m", turns, 0.6).validation_status, "unsupported");
	assert.equal(scoreReplay("ik", "m", turns, 0.6).validated_score, 0.5);
});

test("scoreReplay: non-friction replay turns are excluded from the denominator", () => {
	// One genuine friction turn (averted) plus one clean turn → score 1/1.
	const c = scoreReplay("ik", "m", [turn("a", "wrong_approach", "none"), turn("b", "none", "none")], 0.5);
	assert.equal(c.baseline_friction_turns, 1);
	assert.equal(c.averted_turns, 1);
	assert.equal(c.validated_score, 1);
	assert.equal(c.validation_status, "supported");
});

test("composeRuleText: joins title/summary/detail, dropping blanks", () => {
	assert.equal(composeRuleText({ title: "T", summary: "S", detail: "D" }), "T — S — D");
	assert.equal(composeRuleText({ title: "T", summary: "S", detail: null }), "T — S");
	assert.equal(composeRuleText({ title: "T", summary: "", detail: "" }), "T");
});

test("buildWithRulePrompt injects the rule as a standing instruction; baseline does not", () => {
	const args = { userText: "u", assistantText: "a" };
	const baseline = buildBaselinePrompt(args);
	const withRule = buildWithRulePrompt({ ...args, rule: "Pass --repo to gh pr create" });
	assert.ok(!baseline.includes("STANDING INSTRUCTION"));
	assert.ok(withRule.includes("STANDING INSTRUCTION"));
	assert.ok(withRule.includes("Pass --repo to gh pr create"));
});
