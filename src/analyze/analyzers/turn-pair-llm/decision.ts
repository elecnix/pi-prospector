/**
 * The decision-model path of turn-pair-llm (#338).
 *
 * The generative path asks a model to write a four-field JSON form plus a
 * rationale. Every field is a closed set, so here each becomes one question in a
 * single request: `sentiment` and `friction_type` are Choices,
 * `is_genuine_correction` is a Noul, and `severity` is a Score. The answers map
 * back onto the same stored fields, so every consumer reads them unchanged. The
 * rationale goes: the probabilities are the evidence, and they are stored.
 *
 * The question set is part of identity. Its hash joins the decision model in the
 * config fingerprint, so switching paths, models, or questions marks the earlier
 * nodes stale for the `config` reason instead of mixing verdicts.
 */

import { shortHash, canonicalJson } from "../../input-hash.js";
import { EVIDENCE_SLICE_CEILING } from "../../evidence-slices.js";
import { answerOf, scoreLevel, type DecisionQuestion, type DecisionResponse } from "../../decision-model.js";
import { MAX_TOOL_EVIDENCE_PER_TURN, type ClassifyInput, type ClassifyResult } from "./prompt.js";

/** Severity levels, low to high, in the order the generative path names them. */
export const SEVERITY_LEVELS = ["low", "medium", "high"] as const;

export const TURN_DECISION_QUESTIONS: Record<string, DecisionQuestion> = {
	sentiment: {
		type: "choice",
		instructions: {
			question: "What feeling toward the assistant does `user_message` express?",
			focus: "Judge the user's words in `user_message` only. `prior_turns` and `tool_calls` are context.",
		},
		criteria: {
			neutral: {
				what: "A plain instruction, question, or report with no feeling about the assistant's work",
				examples: ["now add the tests", "what does this flag do?", "continue"],
			},
			frustrated: {
				what: "Annoyance, impatience, or displeasure with what the assistant did",
				examples: ["no, that's wrong", "I already told you twice", "why did you delete that?!"],
			},
			positive: {
				what: "Thanks, approval, or praise for what the assistant did",
				examples: ["perfect, thanks", "great work", "exactly what I wanted"],
			},
		},
	},
	friction_type: {
		type: "choice",
		instructions: {
			question: "What went wrong in the assistant's work, according to `user_message`?",
			focus: "Use `prior_turns` to judge repetition. Use `tool_calls` to judge tool misuse.",
		},
		criteria: {
			none: {
				what: "Nothing went wrong: the user continues the task, asks something new, or approves",
				examples: ["now do the same for the other file", "looks good, ship it"],
			},
			wrong_approach: {
				what: "The assistant chose a method, design, or fix the user rejects",
				examples: ["don't mock it, use the real database", "that's the wrong place to fix this"],
			},
			missed_instruction: {
				what: "The assistant ignored or forgot something the user had asked for",
				examples: ["I said to run the tests first", "you were supposed to keep the old name"],
			},
			tool_misuse: {
				what: "A tool call in `tool_calls` used wrong flags, a wrong target, or a wrong command",
				examples: ["you forgot --repo", "that pushed to the wrong remote"],
			},
			repetition: {
				what: "The assistant repeated a failed attempt, or the user repeats a request from `prior_turns`",
				examples: ["you tried that already", "again, same error"],
			},
			other: {
				what: "Something went wrong that fits none of the other options",
			},
		},
	},
	is_genuine_correction: {
		type: "noul",
		instructions: "Does `user_message` correct something the assistant did or said?",
		criteria: {
			true: {
				what: "The user says the assistant's action, claim, or output was wrong and states what to do instead",
				examples: ["no, use the auth module", "that's not the file I meant"],
			},
			false: {
				what: "The user gives a new instruction, asks a question, or approves, without saying the assistant was wrong",
				examples: ["now add logging", "can you explain this function?"],
			},
		},
	},
	severity: {
		type: "score",
		instructions: "How much work does the problem raised in `user_message` cost the user?",
		criteria: [
			"No problem, or a small slip the user mentions in passing",
			"The user has to stop and redirect the assistant's work",
			"The user has to repeat an instruction already given, undo the assistant's work, or shows strong anger",
		],
	},
};

/** Content hash of the question set: part of the node's config identity. */
export const TURN_DECISION_QUESTIONS_HASH = shortHash(`decision-questions(${canonicalJson(TURN_DECISION_QUESTIONS)})`);

/** Per-turn text caps, matching the generative prompt so both paths see the same turn. */
const USER_TEXT_MAX = 1500;
const ASSISTANT_TEXT_MAX = 1500;
const SLICE_USER_TEXT_MAX = 300;
const SLICE_ASSISTANT_TEXT_MAX = 400;

/** The state every question reads: the turn, its run-up, and its tool evidence. */
export function buildTurnDecisionState(input: ClassifyInput): Record<string, unknown> {
	const state: Record<string, unknown> = {
		user_message: truncate(input.userText, USER_TEXT_MAX),
		assistant_response: truncate(input.assistantText, ASSISTANT_TEXT_MAX),
	};
	const prior = (input.priorTurns ?? []).slice(-EVIDENCE_SLICE_CEILING);
	if (prior.length > 0) {
		state["prior_turns"] = prior.map((t) => ({
			user: truncate(t.userText, SLICE_USER_TEXT_MAX),
			assistant: truncate(t.assistantText, SLICE_ASSISTANT_TEXT_MAX),
		}));
	}
	const calls = input.toolCalls.slice(0, MAX_TOOL_EVIDENCE_PER_TURN).map((tc) => ({
		tool: tc.name,
		...(tc.argumentsPreview ? { arguments: truncate(tc.argumentsPreview, 200) } : {}),
	}));
	const failures = input.toolResults
		.filter((r) => r.isError)
		.slice(0, MAX_TOOL_EVIDENCE_PER_TURN)
		.map((r) => ({ tool: r.toolName, failed: true, ...(r.errorHead ? { error: truncate(r.errorHead, 200) } : {}) }));
	if (calls.length + failures.length > 0) state["tool_calls"] = [...calls, ...failures];
	return state;
}

/** The probabilities behind a decision-model verdict, stored as its evidence. */
export type TurnDecisionProbabilities = Record<string, Record<string, number>>;

/** Map the four answers onto the generative path's classification fields. */
export function parseTurnDecision(response: DecisionResponse): ClassifyResult & { probabilities: TurnDecisionProbabilities } {
	const sentiment = answerOf(response, "sentiment", "choice");
	const friction = answerOf(response, "friction_type", "choice");
	const correction = answerOf(response, "is_genuine_correction", "noul");
	const severity = answerOf(response, "severity", "score");
	return {
		sentiment: sentiment.choice,
		friction_type: friction.choice,
		is_genuine_correction: correction.noul >= 0.5,
		severity: SEVERITY_LEVELS[scoreLevel(severity)] ?? "low",
		rationale: "",
		probabilities: {
			sentiment: sentiment.probabilities,
			friction_type: friction.probabilities,
			is_genuine_correction: { true: correction.noul },
			severity: Object.fromEntries(Object.entries(severity.probabilities).map(([k, p]) => [SEVERITY_LEVELS[Number(k)] ?? k, p])),
		},
	};
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}
