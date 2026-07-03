/**
 * Reduce-phase prompt: turn a session digest (or merged segment summaries plus
 * aggregate stats) into a session summary, positive-signal observations, an
 * exhaustive enumeration of distinct friction points as textual gradients, and
 * concrete proposals (enumerate-then-propose synthesis).
 *
 * The model MUST enumerate ALL distinct friction points first, each as a
 * textual gradient {description, what_to_change, evidence, severity}, and then
 * emit one improvement_proposals entry per friction point. The "prefer a few"
 * bias is deliberately removed — volume is managed at display time, not at
 * synthesis time. Positive signals may additionally yield reinforcement
 * proposals.
 */

import { Type, type Static } from "typebox";
import { shortHash } from "../../input-hash.js";

export const REDUCE_PROMPT = `You analyse a coding-agent session and propose concrete improvements to the
user's configuration, prompts, skills, or workflow. You do NOT make changes.

The digest includes both friction signals and **positive signals** (things that
went well). Use success/failure contrast: compare what went right against what
went wrong. When a session is smooth, focus on reinforcement — capturing what
worked so it can be encoded into standing instructions.

If a CROSS-SESSION CONTRAST section is present, it lists smooth sibling sessions
in the SAME repo. Use them as negative examples: if this session hit friction that
the smooth siblings avoided, say what the smooth sessions did differently and
propose encoding it. Do not invent contrast the evidence does not support.

STEP 1 — ENUMERATE FRICTION: List EVERY distinct friction point in the session.
For each one, write a textual gradient: what went wrong, what should change, the
evidence that supports it, and how severe it is. Do NOT merge or drop distinct
friction points — if three different things went wrong, list three gradients.
If the session was genuinely smooth with no friction, use an empty array.

STEP 2 — RECORD POSITIVE SIGNALS: List the strongest positive signals supplied
by the digest. These are part of the output even when there is no friction.

STEP 3 — PROPOSE: For each friction point you enumerated, write one improvement
proposal. Each friction point gets its own proposal. You may also write
reinforcement proposals for positive patterns worth preserving; use severity
"reinforcement" for those. Overlapping proposals are fine — dedup happens
downstream, not here.

Return your analysis by calling the \`submit_session_analysis\` tool. Do NOT reply
with prose or markdown. The tool takes exactly these fields:
{
  "session_summary": "3-5 sentences summarising the session, its friction, and its strengths; never empty for a non-empty session",
  "friction_points": [
    {
      "description": "what went wrong",
      "what_to_change": "what should be different next time",
      "evidence": "specific moment(s) in the session that show this",
      "severity": "low" | "medium" | "high"
    }
  ],
  "key_positive_signals": [
    { "description": "what went well", "signal": "task-completed-without-correction" | "correction-then-clean-recovery" | "low-tool-failure-density" }
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
      "severity": "friction" | "correction" | "waste" | "suggestion" | "reinforcement"
    }
  ]
}

A "reinforcement" proposal is a proposal that identifies something the agent did
RIGHT and suggests encoding it ("keep doing X", "add this pattern to instructions").
Use severity "reinforcement" (not "suggestion") for positive-pattern proposals.

Every session — even a clean one — MUST produce a session_summary. A clean session
should still yield key_positive_signals and reinforcement proposals if there is
evidence of good patterns worth preserving. Only return an empty
improvement_proposals array if the session is truly empty (no turns at all).

Enumerate exhaustively. Do NOT merge distinct problems into a single entry. Do
NOT prefer a few high-quality proposals over complete coverage. Volume is managed
by display-time grouping, not by dropping signals during synthesis.

Always respond by calling the submit_session_analysis tool — never answer in prose.`;

export const REDUCE_PROMPT_HASH = shortHash(REDUCE_PROMPT);

/** A textual gradient: why friction occurred and what to change. */
export const FrictionPoint = Type.Object({
	description: Type.String(),
	what_to_change: Type.String(),
	evidence: Type.String(),
	severity: Type.String(),
});
export type FrictionPoint = Static<typeof FrictionPoint>;

export const PositiveSignal = Type.Object({
	description: Type.String(),
	signal: Type.String(),
});
export type PositiveSignal = Static<typeof PositiveSignal>;

export const SessionOverviewProperties = Type.Object({
	session_summary: Type.String(),
	friction_points: Type.Array(FrictionPoint),
	key_positive_signals: Type.Array(PositiveSignal),
	improvement_proposals: Type.Array(Type.Record(Type.String(), Type.Unknown())),
	stats: Type.Optional(Type.Record(Type.String(), Type.Union([Type.Number(), Type.Array(Type.String())]))),
});
export type SessionOverviewProperties = Static<typeof SessionOverviewProperties>;

/**
 * Forced-tool-call parameter schema for the reduce phase. Offering this as the
 * single tool and instructing the model to call it yields reliable structured
 * output even from reasoning models that otherwise return prose. Mirrors the
 * JSON contract documented in REDUCE_PROMPT.
 */
export const ReduceToolParameters = Type.Object({
	session_summary: Type.String({
		description: "3-5 sentences summarising the session, its friction, and its strengths; never empty for a non-empty session.",
	}),
	friction_points: Type.Array(
		Type.Object({
			description: Type.String({ description: "what went wrong" }),
			what_to_change: Type.String({ description: "what should be different next time" }),
			evidence: Type.String({ description: "specific moment(s) in the session that show this" }),
			severity: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
		}),
		{ description: "EVERY distinct friction point as a textual gradient. Empty only if the session was genuinely smooth." },
	),
	key_positive_signals: Type.Array(
		Type.Object({
			description: Type.String({ description: "what went well" }),
			signal: Type.Union([
				Type.Literal("task-completed-without-correction"),
				Type.Literal("correction-then-clean-recovery"),
				Type.Literal("low-tool-failure-density"),
			]),
		}),
	),
	improvement_proposals: Type.Array(
		Type.Object({
			target_type: Type.Union([
				Type.Literal("agents_md"),
				Type.Literal("skill"),
				Type.Literal("prompt"),
				Type.Literal("config"),
				Type.Literal("workflow"),
				Type.Literal("general"),
			]),
			target_path: Type.Optional(Type.String({ description: "optional path or section, e.g. AGENTS.md § Tooling" })),
			title: Type.String({ description: "short imperative title" }),
			summary: Type.String({ description: "one sentence" }),
			detail: Type.String({ description: "2-4 sentences with the concrete change to make" }),
			evidence: Type.String({ description: "what in the session motivates this" }),
			confidence: Type.Number({ description: "0.0 to 1.0" }),
			severity: Type.Union([
				Type.Literal("friction"),
				Type.Literal("correction"),
				Type.Literal("waste"),
				Type.Literal("suggestion"),
				Type.Literal("reinforcement"),
			]),
		}),
		{ description: "One proposal per friction point, plus reinforcement proposals for positive patterns worth preserving." },
	),
});

/** The reduce-phase structured-output tool. */
export const REDUCE_TOOL = {
	name: "submit_session_analysis",
	description:
		"Submit the structured analysis of the coding-agent session: summary, an exhaustive enumeration of friction points, positive signals, and one improvement proposal per friction point.",
	parameters: ReduceToolParameters,
};

export function buildReducePrompt(params: {
	digestOrSummaries: string;
	stats: string;
	positiveSignals?: string[];
	/** Cross-session contrast: smooth sibling sessions in the same repo (issue #10). */
	contrastContext?: string;
}): string {
	const parts = [
		"AGGREGATE STATS:",
		params.stats,
	];
	if (params.positiveSignals && params.positiveSignals.length > 0) {
		parts.push("", "POSITIVE SIGNALS:", ...params.positiveSignals);
	}
	if (params.contrastContext && params.contrastContext.length > 0) {
		parts.push("", "CROSS-SESSION CONTRAST:", params.contrastContext);
	}
	parts.push("", "SESSION SIGNALS / SEGMENT SUMMARIES:", params.digestOrSummaries);
	return parts.join("\n");
}

export function parseReduceResponse(
	text: string,
	extractJsonObject: (t: string) => Record<string, unknown>,
): SessionOverviewProperties {
	return parseReduceObject(extractJsonObject(text));
}

/** Normalise an already-parsed reduce object (e.g. forced-tool-call arguments). */
export function parseReduceObject(obj: Record<string, unknown>): SessionOverviewProperties {
	const friction = Array.isArray(obj["friction_points"])
		? (obj["friction_points"] as unknown[])
				.map((x) => normalizeFrictionPoint(x))
				.filter((x): x is FrictionPoint => x !== null)
		: [];
	const positiveSignals = Array.isArray(obj["key_positive_signals"])
		? (obj["key_positive_signals"] as unknown[])
				.map((x) => normalizePositiveSignal(x))
				.filter((x): x is PositiveSignal => x !== null)
		: [];
	const proposals = Array.isArray(obj["improvement_proposals"])
		? (obj["improvement_proposals"] as unknown[])
				.map((x) => normalizeProposal(x))
				.filter((x): x is Record<string, unknown> => x !== null)
		: [];
	return {
		session_summary: typeof obj["session_summary"] === "string" ? (obj["session_summary"] as string) : "",
		friction_points: friction,
		key_positive_signals: positiveSignals,
		improvement_proposals: proposals,
	};
}

const VALID_FRICTION_POINT_SEVERITY = new Set(["low", "medium", "high"]);
const VALID_PROPOSAL_SEVERITY = new Set(["friction", "correction", "waste", "suggestion", "reinforcement"]);
const VALID_POSITIVE_SIGNAL = new Set(["task-completed-without-correction", "correction-then-clean-recovery", "low-tool-failure-density"]);

function normalizeFrictionPoint(value: unknown): FrictionPoint | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const v = value as Record<string, unknown>;
	if (typeof v["description"] !== "string") return null;
	const severity = typeof v["severity"] === "string" && VALID_FRICTION_POINT_SEVERITY.has(v["severity"] as string)
		? (v["severity"] as string)
		: "low";
	return {
		description: v["description"] as string,
		what_to_change: typeof v["what_to_change"] === "string" ? (v["what_to_change"] as string) : "",
		evidence: typeof v["evidence"] === "string" ? (v["evidence"] as string) : "",
		severity,
	};
}

function normalizePositiveSignal(value: unknown): PositiveSignal | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const v = value as Record<string, unknown>;
	if (typeof v["description"] !== "string") return null;
	const signal = typeof v["signal"] === "string" && VALID_POSITIVE_SIGNAL.has(v["signal"] as string)
		? (v["signal"] as string)
		: "";
	return {
		description: v["description"] as string,
		signal,
	};
}

function normalizeProposal(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const proposal: Record<string, unknown> = { ...(value as Record<string, unknown>) };
	proposal["severity"] = typeof proposal["severity"] === "string" && VALID_PROPOSAL_SEVERITY.has(proposal["severity"] as string)
		? proposal["severity"]
		: "suggestion";
	return proposal;
}
