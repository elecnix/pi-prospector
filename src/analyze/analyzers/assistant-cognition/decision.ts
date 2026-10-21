/**
 * The decision-model path of assistant-cognition (#338).
 *
 * Confusion and indecision become Scores whose lowest level is "none", so the
 * mild/moderate/high grade is the Score's most probable level. Surprise needs a
 * verbatim quote, which a decision model cannot produce: a Noul decides whether
 * the turn shows surprise, a Score beside it grades the severity, and only a
 * turn past the threshold pays for a generative call that extracts the quote.
 * The quote is still validated as an exact substring before it is stored.
 *
 * The apology (#318) works the same way, for the same reason: an apology is a
 * concession the assistant made in its own words, so it needs a verbatim quote
 * from the response text. A Noul decides whether the turn carries an apology, a
 * Score beside it grades the severity, and only a turn past the threshold pays
 * for the quote. The apology quote is checked against the **response** text
 * only — an apology is something the user saw, not a phrase in private
 * reasoning.
 */

import { Type } from "typebox";
import { shortHash, canonicalJson } from "../../input-hash.js";
import { answerOf, scoreLevel, type DecisionQuestion, type DecisionResponse } from "../../decision-model.js";
import type { CognitionInput, ConfusionEntry, IndecisionEntry } from "./prompt.js";

/** Graded levels above "none", in Score order. */
export const COGNITION_LEVELS = ["mild", "moderate", "high"] as const;

/** A Noul above this calls the turn surprised. */
export const SURPRISE_THRESHOLD = 0.5;

/** A Noul above this calls the turn apologetic. */
export const APOLOGY_THRESHOLD = 0.5;

export const COGNITION_DECISION_QUESTIONS: Record<string, DecisionQuestion> = {
	confusion: {
		type: "score",
		instructions: {
			question: "How lost is the assistant in `thinking_trace` and `response_text`?",
			focus: "Confusion means missing context it needs, or re-reading material without making progress.",
		},
		criteria: [
			"The assistant states what it will do and does it, with no doubt about the task or the code",
			"The assistant is unsure about one detail, such as where something lives or what a name means, and guesses or looks it up",
			"The assistant says it lacks context it needs, or reads the same material again without progress",
			"The assistant cannot work out what is being asked or what state things are in, and stalls",
		],
	},
	indecision: {
		type: "score",
		instructions: {
			question: "How much does the assistant switch between approaches in `thinking_trace` and `response_text`?",
			focus: "Indecision means abandoning a plan for another and coming back, within this turn.",
		},
		criteria: [
			"The assistant follows one approach from start to end",
			"The assistant compares options, or revises a step, and then commits to one approach",
			"The assistant starts on one approach, abandons it for another, and later returns to the first",
			{
				summary: "The assistant reverses its choice of approach three or more times and never settles",
				not_for: "Listing options before choosing one, or correcting a single step",
			},
		],
	},
	surprise: {
		type: "noul",
		instructions: "Does `thinking_trace` or `response_text` say that something observed differs from what the assistant expected?",
		criteria: {
			true: {
				what: "The assistant notes an expectation that was violated",
				examples: ["that's odd", "I expected the test to pass but it failed", "wait, this file doesn't exist"],
			},
			false: {
				what: "The assistant reports results without saying they differ from what it expected",
				examples: ["the tests pass", "now I'll edit the file"],
			},
		},
	},
	surprise_severity: {
		type: "score",
		instructions: "How much does the unexpected observation in `thinking_trace` or `response_text` change the assistant's plan?",
		criteria: [
			"Nothing unexpected is observed",
			"A small oddity the assistant notes and moves past",
			"An unexpected result that makes the assistant change its next step",
			"An unexpected result that overturns the assistant's plan or understanding",
		],
	},
	apology: {
		type: "noul",
		instructions:
			"Does `response_text` show the assistant conceding that it was wrong? An apology is the assistant's own " +
			"concession, in the words it said to the user: 'sorry', 'my mistake', 'I was wrong'. A regret about the " +
			"user's situation ('sorry to hear that') is not a concession, and a quotation of the user's words is not " +
			"the assistant conceding.",
		criteria: {
			true: {
				what: "The assistant admits it was wrong",
				examples: ["sorry, my mistake", "I was wrong about the flag", "apologies, that was my error"],
			},
			false: {
				what: "The assistant does not concede an error",
				examples: ["here is the fix", "sorry to hear that, let me check"],
			},
		},
	},
	apology_severity: {
		type: "score",
		instructions: "How much does the concession in `response_text` cost the user?",
		criteria: [
			"No concession is made",
			"A passing concession, with the work carried on unchanged",
			"A concession that walks back a stated fact, so the user has to redo the check",
			"A concession that undoes work the user was relying on",
		],
	},
};

export const QUOTE_PROMPT = `You copy evidence from one coding-agent turn.

The turn's THINKING TRACE or RESPONSE TEXT says that something the assistant
observed differed from what it expected. Call the \`quote_surprise\` tool with
the shortest passage that says so, copied character for character from the
THINKING TRACE or the RESPONSE TEXT. Never paraphrase, trim inside the passage,
or invent text.`;

export const QUOTE_PROMPT_HASH = shortHash(QUOTE_PROMPT);

export const QUOTE_TOOL = {
	name: "quote_surprise",
	description: "Submit the verbatim passage that shows the assistant's surprise.",
	parameters: Type.Object({ quote: Type.String({ description: "verbatim text from the thinking trace or response" }) }),
};

export const APOLOGY_QUOTE_PROMPT = `You copy evidence from one coding-agent turn.

The turn's RESPONSE TEXT shows the assistant conceding that it was wrong. Call
the \`quote_apology\` tool with the shortest passage that says so, copied
character for character from the RESPONSE TEXT. Never paraphrase, trim inside
the passage, or invent text.`;

export const APOLOGY_QUOTE_PROMPT_HASH = shortHash(APOLOGY_QUOTE_PROMPT);

export const APOLOGY_QUOTE_TOOL = {
	name: "quote_apology",
	description: "Submit the verbatim passage that shows the assistant's apology.",
	parameters: Type.Object({ quote: Type.String({ description: "verbatim text from the response" }) }),
};

/** Content hash of the question set and quote prompt: part of the node's config identity. */
export const COGNITION_DECISION_HASH = shortHash(
	`cognition-decision(${canonicalJson(COGNITION_DECISION_QUESTIONS)}|${QUOTE_PROMPT_HASH}|${APOLOGY_QUOTE_PROMPT_HASH})`,
);

/** Same cap as the generative prompt, so both paths read the same turn. */
const SECTION_MAX = 6000;

export function buildCognitionDecisionState(input: CognitionInput): Record<string, unknown> {
	return {
		user_message: truncate(input.userText, SECTION_MAX),
		thinking_trace: truncate(input.thinkingText, SECTION_MAX),
		response_text: truncate(input.assistantText, SECTION_MAX),
	};
}

/** A graded entry for a Score whose most probable level is above "none", else none. */
function graded(response: DecisionResponse, name: string): Array<ConfusionEntry | IndecisionEntry> {
	const level = scoreLevel(answerOf(response, name, "score"));
	const label = COGNITION_LEVELS[level - 1];
	return label ? [{ level: label, rationale: "" }] : [];
}

export interface CognitionDecision {
	confusion: ConfusionEntry[];
	indecision: IndecisionEntry[];
	/** The surprise grade when the Noul passes the threshold, else undefined. */
	surpriseSeverity: (typeof COGNITION_LEVELS)[number] | undefined;
	/** The apology grade when the Noul passes the threshold, else undefined. */
	apologySeverity: (typeof COGNITION_LEVELS)[number] | undefined;
	probabilities: Record<string, Record<string, number>>;
}

export function parseCognitionDecision(response: DecisionResponse): CognitionDecision {
	const surprise = answerOf(response, "surprise", "noul");
	const severity = answerOf(response, "surprise_severity", "score");
	const apology = answerOf(response, "apology", "noul");
	const apologySeverity = answerOf(response, "apology_severity", "score");
	const labelled = (p: Record<string, number>) =>
		Object.fromEntries(Object.entries(p).map(([k, v]) => [Number(k) === 0 ? "none" : (COGNITION_LEVELS[Number(k) - 1] ?? k), v]));
	return {
		confusion: graded(response, "confusion"),
		indecision: graded(response, "indecision"),
		// A surprised turn whose severity reads "none" is still a surprise: grade it mild.
		surpriseSeverity: surprise.noul > SURPRISE_THRESHOLD ? (COGNITION_LEVELS[Math.max(1, scoreLevel(severity)) - 1] ?? "mild") : undefined,
		// Same rule for an apology: the concession is the finding, the grade is
		// how much it cost.
		apologySeverity: apology.noul > APOLOGY_THRESHOLD ? (COGNITION_LEVELS[Math.max(1, scoreLevel(apologySeverity)) - 1] ?? "mild") : undefined,
		probabilities: {
			confusion: labelled(answerOf(response, "confusion", "score").probabilities),
			indecision: labelled(answerOf(response, "indecision", "score").probabilities),
			surprise: { true: surprise.noul },
			surprise_severity: labelled(severity.probabilities),
			apology: { true: apology.noul },
			apology_severity: labelled(apologySeverity.probabilities),
		},
	};
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}
