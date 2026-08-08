/**
 * Prompt and response parsing for frustration-lexicon.
 *
 * The model is asked about a *word*, not a conversation. That is deliberate: a
 * term node's recipe is the term alone, so the answer must depend on nothing
 * else. Feeding an example sentence would make the recipe dishonest — identity
 * would claim "just the word" while the verdict actually turned on a sentence
 * from one particular session — and the first session to nominate the word would
 * silently fix the verdict for every other.
 *
 * The cost of that honesty is that genuinely ambiguous words come back neutral.
 * That is the right failure: a lexicon entry describes a word's habitual
 * character, and turn-level corroboration (tool failures, repetition, shouting)
 * is what supplies the missing context downstream.
 */

import { shortHash } from "../../input-hash.js";
import { Type } from "typebox";

export const CLASSIFY_TERM_PROMPT = `You judge single words for a multilingual lexicon used to detect
user frustration in coding-agent conversations.

You will be given one token — a word, an abbreviation, or an emoji, in any
language. Judge how that token is *habitually* used when a person addresses a
software assistant. Do not guess at a specific conversation; there is none.

Return your judgement by calling the \`classify_term\` tool with exactly these fields:
{
  "polarity": "frustration" | "praise" | "neutral",
  "category": "profanity" | "negation" | "correction" | "repetition" | "urgency" | "confusion" | "dissatisfaction" | "praise" | "none",
  "language": "an ISO 639-1 code, or \\"und\\" if the token is language-neutral or unknown",
  "confidence": 0.0 to 1.0,
  "rationale": "one short sentence"
}

Guidance:
- "frustration" covers profanity, negation and correction markers ("no", "wrong",
  "nope", "faux"), repetition markers ("again", "encore", "still"), impatience,
  and angry emoji.
- "praise" covers thanks, approval, and celebratory emoji — these are just as
  useful, because they mark what the assistant did right.
- Be strict. The great majority of words are ordinary vocabulary: if a token only
  signals frustration in a particular sentence rather than by its own character,
  it is "neutral" with category "none".
- A word that is merely negative in subject matter ("bug", "error", "fail") is
  NOT a frustration signal — it describes the work, not the user's feeling.

Always respond by calling the classify_term tool — never answer in prose.`;

export const CLASSIFY_TERM_PROMPT_HASH = shortHash(CLASSIFY_TERM_PROMPT);

/** Forced-tool-call schema for the term judgement (reliable structured output). */
export const CLASSIFY_TERM_TOOL = {
	name: "classify_term",
	description: "Submit the structured judgement for a single lexicon term.",
	parameters: Type.Object({
		polarity: Type.Union([Type.Literal("frustration"), Type.Literal("praise"), Type.Literal("neutral")]),
		category: Type.Union([
			Type.Literal("profanity"),
			Type.Literal("negation"),
			Type.Literal("correction"),
			Type.Literal("repetition"),
			Type.Literal("urgency"),
			Type.Literal("confusion"),
			Type.Literal("dissatisfaction"),
			Type.Literal("praise"),
			Type.Literal("none"),
		]),
		language: Type.String({ description: "ISO 639-1 code, or 'und'" }),
		confidence: Type.Number({ minimum: 0, maximum: 1 }),
		rationale: Type.String({ description: "one short sentence" }),
	}),
};

/** The user-channel content for one term. Kept minimal — the term is the whole input. */
export function buildClassifyTermPrompt(term: string): string {
	return `TERM: ${term}`;
}

/** The fields the model returns for a single term. */
export interface ClassifyTermResult {
	polarity: string;
	category: string;
	language: string;
	confidence: number;
	rationale: string;
}

const VALID_POLARITY = new Set(["frustration", "praise", "neutral"]);
const VALID_CATEGORY = new Set([
	"profanity",
	"negation",
	"correction",
	"repetition",
	"urgency",
	"confusion",
	"dissatisfaction",
	"praise",
	"none",
]);

/** Normalise an already-parsed judgement (e.g. forced-tool-call arguments). */
export function parseClassifyTermObject(obj: Record<string, unknown>): ClassifyTermResult {
	const polarity = pickString(obj["polarity"], VALID_POLARITY, "neutral");
	const category = pickString(obj["category"], VALID_CATEGORY, "none");
	const rawConfidence = typeof obj["confidence"] === "number" ? obj["confidence"] : 0;
	return {
		polarity,
		// A neutral verdict must never carry a signal category, or downstream grouping
		// would report a frustration type for a word the model declined to flag.
		category: polarity === "neutral" ? "none" : category,
		language: typeof obj["language"] === "string" ? (obj["language"] as string).slice(0, 16) : "und",
		confidence: Math.max(0, Math.min(1, rawConfidence)),
		rationale: typeof obj["rationale"] === "string" ? (obj["rationale"] as string).slice(0, 300) : "",
	};
}

function pickString(value: unknown, allowed: Set<string>, fallback: string): string {
	return typeof value === "string" && allowed.has(value) ? value : fallback;
}
