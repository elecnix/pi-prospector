/**
 * Replay prompt for proposal-validate.
 *
 * We reuse turn-pair-llm's classifier verbatim (same system prompt, same JSON
 * schema, same parser) so the "with-rule" and "without-rule" classifications are
 * directly comparable. The only difference is that the with-rule prompt injects
 * the candidate proposal as a standing instruction the agent "already had"
 * before responding — exactly the Constitutional-AI critique-template idea: turn
 * the proposed rule into a concrete condition the replay is judged against.
 */

import { buildClassifyPrompt } from "../turn-pair-llm/prompt.js";

export interface ReplayInput {
	userText: string;
	assistantText: string;
	/** The candidate rule text (proposal title + summary + detail). */
	rule: string;
}

/**
 * The baseline (without-rule) prompt is the plain classifier input. We pass no
 * correction hint so the validator judges the turn on its own merits.
 */
export function buildBaselinePrompt(input: { userText: string; assistantText: string }): string {
	return buildClassifyPrompt({
		userText: input.userText,
		assistantText: input.assistantText,
		correctionText: null,
		toolCalls: [],
		toolResults: [],
	});
}

/**
 * The with-rule prompt prepends the candidate standing instruction, then the
 * same turn. If the rule genuinely addresses the friction, a faithful classifier
 * should now judge the turn as friction-free.
 */
export function buildWithRulePrompt(input: ReplayInput): string {
	return [
		"STANDING INSTRUCTION ALREADY IN EFFECT (the agent had this guidance before responding):",
		input.rule.trim(),
		"",
		"Given that the instruction above was already in effect, classify the turn below.",
		"",
		buildClassifyPrompt({
			userText: input.userText,
			assistantText: input.assistantText,
			correctionText: null,
			toolCalls: [],
			toolResults: [],
		}),
	].join("\n");
}

/** Compose the candidate rule text from a proposal's title/summary/detail. */
export function composeRuleText(p: { title: string; summary: string; detail?: string | null }): string {
	return [p.title, p.summary, p.detail ?? ""].map((s) => (s ?? "").trim()).filter((s) => s.length > 0).join(" — ");
}
