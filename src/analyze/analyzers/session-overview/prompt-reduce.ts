/**
 * Reduce-phase prompt: turn a session digest (or merged segment summaries plus
 * aggregate stats) into a session summary and a set of improvement proposals.
 */

import { shortHash } from "../../input-hash.js";

export const REDUCE_PROMPT = `You analyse a coding-agent session and propose concrete improvements to the
user's configuration, prompts, skills, or workflow. You do NOT make changes.

Return ONLY a JSON object with exactly these fields:
{
  "session_summary": "3-5 sentences summarising the session and its friction",
  "key_friction_points": [
    { "description": "what went wrong", "severity": "low" | "medium" | "high" }
  ],
  "improvement_proposals": [
    {
      "target_type": "agents_md" | "skill" | "prompt" | "config" | "workflow" | "general",
      "target_path": "optional path or section, e.g. AGENTS.md § Tooling",
      "title": "short imperative title",
      "summary": "one sentence",
      "detail": "2-4 sentences with the concrete change to make",
      "evidence": "what in the session motivates this",
      "confidence": 0.0,
      "severity": "friction" | "correction" | "waste" | "suggestion"
    }
  ]
}

Only propose changes that the evidence supports. If the session was smooth,
return an empty "improvement_proposals" array. Prefer a few high-quality
proposals over many speculative ones.`;

export const REDUCE_PROMPT_HASH = shortHash(REDUCE_PROMPT);

export interface KeyFrictionPoint {
	description: string;
	severity: string;
}

export interface SessionOverviewProperties {
	session_summary: string;
	key_friction_points: KeyFrictionPoint[];
	improvement_proposals: Array<Record<string, unknown>>;
	stats?: Record<string, number>;
}

export function buildReducePrompt(params: { digestOrSummaries: string; stats: string }): string {
	return [
		"AGGREGATE STATS:",
		params.stats,
		"",
		"SESSION SIGNALS / SEGMENT SUMMARIES:",
		params.digestOrSummaries,
	].join("\n");
}

export function parseReduceResponse(
	text: string,
	extractJsonObject: (t: string) => Record<string, unknown>,
): SessionOverviewProperties {
	const obj = extractJsonObject(text);
	const friction = Array.isArray(obj["key_friction_points"])
		? (obj["key_friction_points"] as unknown[])
				.map((x) => normalizeFriction(x))
				.filter((x): x is KeyFrictionPoint => x !== null)
		: [];
	const proposals = Array.isArray(obj["improvement_proposals"])
		? (obj["improvement_proposals"] as unknown[]).filter(
				(x): x is Record<string, unknown> => x !== null && typeof x === "object",
			)
		: [];
	return {
		session_summary: typeof obj["session_summary"] === "string" ? (obj["session_summary"] as string) : "",
		key_friction_points: friction,
		improvement_proposals: proposals,
	};
}

function normalizeFriction(value: unknown): KeyFrictionPoint | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	if (typeof v["description"] !== "string") return null;
	return {
		description: v["description"] as string,
		severity: typeof v["severity"] === "string" ? (v["severity"] as string) : "low",
	};
}
