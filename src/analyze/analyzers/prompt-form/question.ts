/**
 * The classifier question prompt-form registers with the shared message-answers
 * layer. It reads no punctuation: a person may not type a question mark, and
 * some languages do not use one. The model judges what the person is doing.
 */

import { registerMessageQuestion, questionKey, type MessageQuestion } from "../../message-questions.js";

export const PROMPT_KINDS = ["question", "instruction", "correction", "other"] as const;
export type PromptKind = (typeof PROMPT_KINDS)[number];

export const PROMPT_KIND_QUESTION: MessageQuestion = {
	id: "prompt-kind",
	version: 1,
	owner: "prompt-form",
	origins: ["typed"],
	question: {
		type: "choice",
		instructions: {
			question: "What is the person doing in `message`?",
			focus:
				"Judge what the person wants, in any language, with or without punctuation. " +
				"A request to change, run, create or look into something is an instruction, even when it is phrased politely.",
		},
		criteria: {
			question: {
				what: "Asking for information or an explanation",
				examples: ["why did the build fail", "how do I rotate the key", "pourquoi ça échoue"],
			},
			instruction: {
				what: "Asking the assistant to do something: change, run, create, investigate, continue or approve a step",
				examples: ["fix the failing build", "use the other branch", "yes, go ahead"],
			},
			correction: {
				what: "Saying the assistant was wrong, ignored an earlier request, or must redo something",
				examples: ["no, that is wrong", "I told you to use the other flag"],
			},
			other: {
				what: "A greeting, thanks, a remark or text that asks for nothing",
				examples: ["thanks", "hello", "interesting"],
			},
		},
	},
};

/** The key the answer is stored under. */
export const PROMPT_KIND_KEY = questionKey(PROMPT_KIND_QUESTION);

registerMessageQuestion(PROMPT_KIND_QUESTION);
