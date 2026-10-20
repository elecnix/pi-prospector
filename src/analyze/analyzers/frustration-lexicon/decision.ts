/**
 * The decision-model path of frustration-lexicon (#338).
 *
 * `polarity` and `category` become Choices with the generative tool's options,
 * and `language` a Choice over the languages the corpus's verdicts name, plus
 * "und" for language-neutral tokens and "other" for the rest. The polarity's
 * probability replaces the self-reported confidence, so `minConfidence` keeps
 * its meaning downstream. The state is the term alone, as on the generative
 * path: a verdict cached corpus-wide may depend on nothing else.
 */

import { shortHash, canonicalJson } from "../../input-hash.js";
import { answerOf, type DecisionQuestion, type DecisionResponse } from "../../decision-model.js";
import type { ClassifyTermResult } from "./prompt.js";

/** Languages that the corpus's non-neutral verdicts name, by ISO 639-1 code. */
export const TERM_LANGUAGES: Record<string, string> = {
	en: "English",
	fr: "French",
	es: "Spanish",
	pt: "Portuguese",
	it: "Italian",
	de: "German",
	nl: "Dutch",
	sv: "Swedish",
	fi: "Finnish",
	ru: "Russian",
	uk: "Ukrainian",
	sr: "Serbian",
	tr: "Turkish",
	vi: "Vietnamese",
	zh: "Chinese",
	ja: "Japanese",
};

export const TERM_DECISION_QUESTIONS: Record<string, DecisionQuestion> = {
	polarity: {
		type: "choice",
		instructions: {
			question: "When a person types `term` to a software assistant, does the word itself express how they feel about the interaction?",
			focus:
				"Judge the word's habitual use, with no particular conversation. A word that names a thing, a tool, a status, " +
				"or a topic is neutral, however negative that thing is.",
		},
		criteria: {
			neutral: {
				what: "Ordinary vocabulary: names, tools, commands, grammar words, reporting verbs, status words and icons",
				examples: ["bug", "error", "git", "but", "already", "stopped", "pushed", "successfully", "✅"],
			},
			frustration: {
				what: "Profanity, negation or correction markers, repetition markers, impatience, angry emoji",
				examples: ["wrong", "nope", "again", "still", "stop", "wtf", "🤬"],
			},
			praise: {
				what: "Thanks, approval, or praise directed at the assistant, celebratory emoji",
				examples: ["thanks", "perfect", "awesome", "🎉"],
			},
		},
	},
	category: {
		type: "choice",
		instructions: "Which kind of signal is `term`, if it is a frustration or praise signal at all?",
		criteria: {
			none: { what: "Not a signal: ordinary vocabulary", examples: ["file", "but", "pushed"] },
			profanity: { what: "A swear word or crude insult", examples: ["fuck", "merde"] },
			negation: { what: "A word that says no or rejects", examples: ["no", "nope", "non"] },
			correction: { what: "A word that says something is wrong", examples: ["wrong", "faux", "incorrect"] },
			repetition: { what: "A word that says something happened before", examples: ["again", "encore", "still"] },
			urgency: { what: "A word that demands speed", examples: ["now", "asap", "hurry"] },
			confusion: { what: "A word that says the person does not understand", examples: ["huh", "confused", "???"] },
			dissatisfaction: { what: "A word of displeasure or disappointment", examples: ["ugh", "useless", "terrible"] },
			praise: { what: "A word of thanks or approval", examples: ["thanks", "perfect", "merci"] },
		},
	},
	language: {
		type: "choice",
		instructions: "Which language is `term` a word of?",
		criteria: {
			...Object.fromEntries(Object.entries(TERM_LANGUAGES).map(([code, name]) => [code, name])),
			und: { what: "Language-neutral or shared by many languages: emoji, symbols, abbreviations, code names", examples: ["🎉", "ok", "ci", "???"] },
			other: "A language not listed",
		},
	},
};

export const TERM_DECISION_QUESTIONS_HASH = shortHash(`term-decision(${canonicalJson(TERM_DECISION_QUESTIONS)})`);

export function parseTermDecision(response: DecisionResponse): ClassifyTermResult & { probabilities: Record<string, Record<string, number>> } {
	const polarity = answerOf(response, "polarity", "choice");
	const category = answerOf(response, "category", "choice");
	const language = answerOf(response, "language", "choice");
	return {
		polarity: polarity.choice,
		// Same rule as the generative path: a neutral verdict never carries a category.
		category: polarity.choice === "neutral" ? "none" : category.choice,
		language: language.choice === "other" ? "und" : language.choice,
		confidence: polarity.probabilities[polarity.choice] ?? polarity.confidence,
		rationale: "",
		probabilities: { polarity: polarity.probabilities, category: category.probabilities, language: language.probabilities },
	};
}
