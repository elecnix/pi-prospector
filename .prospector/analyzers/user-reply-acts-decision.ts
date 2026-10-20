/**
 * The decision-model path of user-reply-acts (#338).
 *
 * A reply can carry several acts, so each act class is a Noul. Every act also
 * needs a verbatim quote, which a decision model cannot write. It can pick one,
 * though: code splits the visible reply into numbered sentences, and each class
 * carries a speculative Choice over those ids, asked in the same request. The
 * quote is the chosen sentence, so it is an exact substring by construction and
 * no generative call is needed. Graded parts (acceptance and refusal level,
 * question purpose, memory scope) are Choices beside their Noul.
 *
 * One act per class per reply: the generative path can list two questions, this
 * path records the most probable one. The distribution roll-up counts replies
 * per class, which this keeps exact.
 *
 * Not an `.analyzer.ts` file, so the loader never treats it as an analyzer. Its
 * question set is hashed into the analyzer's identity through
 * `modelsForIdentity`, because the loader's content hash covers only the
 * analyzer module's own text.
 */

import { shortHash, canonicalJson } from "../../src/analyze/input-hash.js";
import { answerOf, type DecisionQuestion, type DecisionResponse } from "../../src/analyze/decision-model.js";

/** A Noul above this records the act. */
export const ACT_THRESHOLD = 0.5;
/** A Choice accepts at most 255 options; keep the sentence list well inside it. */
export const MAX_SENTENCES = 80;

/**
 * Split a reply into trimmed sentences and lines, each a verbatim substring of
 * `text`. Splits after `.`, `?` or `!` followed by whitespace, and at newlines.
 */
export function splitReplySentences(text: string): string[] {
	const out: string[] = [];
	for (const line of text.split(/\n+/)) {
		for (const piece of line.split(/(?<=[.?!])\s+/)) {
			const t = piece.trim();
			if (t.length > 0) out.push(t);
		}
	}
	return out;
}

const sentenceId = (i: number) => `S${i + 1}`;

const ACTS = {
	acceptance: {
		instructions: "Does `reply` accept, approve, or tell the assistant to proceed with what `assistant_previous` proposed or did?",
		true: { what: "The user endorses the assistant's proposal or output", examples: ["ok", "yes, go ahead", "ship it", "looks good"] },
		false: { what: "The user does not react to a proposal, or rejects it", examples: ["now add tests", "no, revert that"] },
	},
	refusal: {
		instructions: "Does `reply` reject, correct, or push back on what `assistant_previous` proposed or did?",
		true: { what: "The user declines, says the assistant was wrong, or reprimands it", examples: ["no, don't", "this is wrong", "the indentation is still not fixed", "revert"] },
		false: { what: "The user accepts, continues, or asks without objecting", examples: ["thanks", "what about the other file?"] },
	},
	question: {
		instructions: "Does `reply` ask the assistant a question?",
		true: { what: "The user asks something, usually ending with a question mark", examples: ["what does this flag do?", "is it running?", "should we use A or B?"] },
		false: { what: "The user states, instructs, or answers without asking", examples: ["use A", "369 merged"] },
	},
	answer: {
		instructions: "Does `reply` answer a question that `assistant_previous` asked the user?",
		true: { what: "The assistant asked the user something and the user gives the answer", examples: ["A", "the first one", "yes, the blue one"] },
		false: { what: "The assistant asked nothing, or the user does not answer it" },
	},
	command: {
		instructions: "Does `reply` tell the assistant to do something, in the imperative or with words like should, must, or need to?",
		true: { what: "An order to the assistant, not phrased as a question", examples: ["create a linear issue", "use gh monitor", "keep the old name", "I want you to merge it"] },
		false: { what: "A question, a report, or a reaction with no order", examples: ["can you create an issue?", "369 merged"] },
	},
	information_provision: {
		instructions: "Does `reply` give the assistant facts, context, or a status update without asking or ordering anything?",
		true: { what: "The user drops information into the conversation", examples: ["369 merged", "the old parser was written last spring", "staging is red"] },
		false: { what: "The user only asks, orders, or reacts" },
	},
	memory: {
		instructions: "Does `reply` state a lasting preference or convention that should be remembered for future sessions?",
		true: { what: "A stable preference or project convention", examples: ["I always want tests first", "this repo uses node:test, never jest"] },
		false: { what: "Task progress, a one-off fact, or a secret", examples: ["the build passed", "the token is abc"] },
	},
	continuation: {
		instructions: "Does `reply` move to a new, unrelated topic without accepting, refusing, asking, answering, or ordering?",
		true: { what: "A topic shift with no other act" },
		false: { what: "The reply reacts to the assistant, asks, answers, orders, or informs" },
	},
	other: {
		instructions: "Is `reply` small talk, a joke, or something that is not a reaction, question, answer, order, or information?",
		true: { what: "Small talk or something unclassifiable", examples: ["haha", "good morning"] },
		false: { what: "Any reply that carries a reaction, question, answer, order, or information" },
	},
} as const;

type ActName = keyof typeof ACTS;
const QUOTED: readonly ActName[] = ["acceptance", "refusal", "question", "answer", "command", "information_provision", "memory"];

const SUBTYPES: Record<string, DecisionQuestion> = {
	acceptance_level: {
		type: "choice",
		instructions: "How much of what `assistant_previous` proposed does `reply` accept?",
		criteria: { full: "All of it", partial: "Part of it, while another part is refused or changed" },
	},
	refusal_level: {
		type: "choice",
		instructions: "How much of what `assistant_previous` proposed or did does `reply` reject?",
		criteria: { full: "All of it", partial: "Part of it, while another part is accepted" },
	},
	question_purpose: {
		type: "choice",
		instructions: "What does the question in `reply` ask the assistant for?",
		criteria: {
			request: { what: "To do, look up, or change something new", examples: ["can you check the CI?"] },
			decision: { what: "To choose or recommend among options the user poses", examples: ["should we use A or B?"] },
			clarify: { what: "To re-explain or expand what `assistant_previous` already said", examples: ["what do you mean by stale?"] },
			information: { what: "A fact, status, or state of the world", examples: ["is it running?", "what does this flag do?"] },
		},
	},
	memory_scope: {
		type: "choice",
		instructions: "Where does the preference or convention in `reply` apply?",
		criteria: { global: "To all of the user's work: style, workflow, tools", project: "To this repository only: its test runner, layout, conventions" },
	},
};

/** The fixed part of the question set, hashed into identity. Quote Choices vary only in their options. */
export const REPLY_DECISION_HASH = shortHash(`reply-decision(${canonicalJson({ ACTS, SUBTYPES, MAX_SENTENCES })})`);

export function buildReplyDecisionRequest(priorAssistantText: string, visibleReply: string, model: string) {
	const sentences = splitReplySentences(visibleReply).slice(0, MAX_SENTENCES);
	const questions: Record<string, DecisionQuestion> = {};
	for (const [name, act] of Object.entries(ACTS)) {
		questions[name] = { type: "noul", instructions: act.instructions, criteria: { true: act.true, false: act.false } };
	}
	if (sentences.length > 0) {
		for (const name of QUOTED) {
			questions[`${name}_quote`] = {
				type: "choice",
				instructions: `Which sentence of \`reply_sentences\` best shows this: ${ACTS[name].instructions}`,
				criteria: Object.fromEntries(sentences.map((_, i) => [sentenceId(i), null])) as unknown as Record<string, string>,
			};
		}
	}
	Object.assign(questions, SUBTYPES);
	const state = {
		assistant_previous: priorAssistantText,
		reply: visibleReply,
		reply_sentences: Object.fromEntries(sentences.map((s, i) => [sentenceId(i), s])),
	};
	return { request: { model, state, questions }, sentences };
}

export interface ReplyDecision {
	acceptances: Array<{ level: "full" | "partial"; quote: string; rationale: string }>;
	refusals: Array<{ level: "full" | "partial"; quote: string; rationale: string }>;
	questions: Array<{ purpose: "request" | "decision" | "clarify" | "information"; quote: string; rationale: string }>;
	answers: Array<{ quote: string; rationale: string }>;
	commands: Array<{ quote: string; rationale: string }>;
	information_provisions: Array<{ quote: string; rationale: string }>;
	memories: Array<{ scope: "global" | "project"; quote: string; rationale: string }>;
	continuation: boolean;
	other: boolean;
	probabilities: Record<string, Record<string, number>>;
}

export function parseReplyDecision(response: DecisionResponse, sentences: readonly string[]): ReplyDecision {
	const p = (name: ActName) => answerOf(response, name, "noul").noul;
	const quote = (name: ActName): string | undefined => {
		if (sentences.length === 0) return undefined;
		const id = answerOf(response, `${name}_quote`, "choice").choice;
		return sentences[Number(id.slice(1)) - 1];
	};
	const has = (name: ActName) => p(name) > ACT_THRESHOLD && quote(name) !== undefined;
	const pick = <T extends string>(name: string) => answerOf(response, name, "choice").choice as T;

	const out: ReplyDecision = {
		acceptances: has("acceptance") ? [{ level: pick<"full" | "partial">("acceptance_level"), quote: quote("acceptance")!, rationale: "" }] : [],
		refusals: has("refusal") ? [{ level: pick<"full" | "partial">("refusal_level"), quote: quote("refusal")!, rationale: "" }] : [],
		questions: has("question") ? [{ purpose: pick<"request" | "decision" | "clarify" | "information">("question_purpose"), quote: quote("question")!, rationale: "" }] : [],
		answers: has("answer") ? [{ quote: quote("answer")!, rationale: "" }] : [],
		commands: has("command") ? [{ quote: quote("command")!, rationale: "" }] : [],
		information_provisions: has("information_provision") ? [{ quote: quote("information_provision")!, rationale: "" }] : [],
		memories: has("memory") ? [{ scope: pick<"global" | "project">("memory_scope"), quote: quote("memory")!, rationale: "" }] : [],
		continuation: p("continuation") > ACT_THRESHOLD,
		other: p("other") > ACT_THRESHOLD,
		probabilities: Object.fromEntries((Object.keys(ACTS) as ActName[]).map((name) => [name, { true: p(name) }])),
	};
	// Same invariants as the generative parser: an act overrides continuation and other.
	const hasActs = QUOTED.some((name) => has(name));
	if (hasActs) {
		out.continuation = false;
		out.other = false;
	}
	return out;
}
