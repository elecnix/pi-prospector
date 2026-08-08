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
import { extractJsonObject } from "../turn-pair-llm/prompt.js";
import { Type } from "typebox";

export const CLASSIFY_TERM_PROMPT = `You judge single words for a multilingual lexicon used to detect
user frustration in coding-agent conversations.

You will be given one entry — a single word, an abbreviation, an emoji, or a
short two-word phrase, in any language. Judge how that entry is *habitually* used
when a person addresses a software assistant. Do not guess at a specific
conversation; there is none.

For a two-word phrase, judge the phrase as a unit. Many frustration expressions
are exactly this: the individual words are ordinary, and only together do they
express disengagement or annoyance — "laisse tomber", "never mind", "forget it",
"trop lent", "come on", "not again". Judge such a phrase on what it means as a
whole, not on its parts.

Return your judgement by calling the \`classify_term\` tool with exactly these fields:
{
  "polarity": "frustration" | "praise" | "neutral",
  "category": "profanity" | "negation" | "correction" | "repetition" | "urgency" | "confusion" | "dissatisfaction" | "praise" | "none",
  "language": "an ISO 639-1 code, or \\"und\\" if the token is language-neutral or unknown",
  "confidence": 0.0 to 1.0,
  "rationale": "one short sentence"
}

THE TEST: does this entry express how the person FEELS about the interaction? If
it names a thing, a tool, a status, or a topic, it is "neutral" — however
negative that thing may be.

Guidance:
- "frustration" covers profanity, negation and correction markers ("no", "wrong",
  "nope", "faux"), repetition markers ("again", "encore", "still"), impatience,
  and angry emoji.
- "praise" covers thanks, approval, and celebratory emoji — these are just as
  useful, because they mark what the assistant did right.
- Be strict. The great majority of entries are ordinary vocabulary: if an entry
  only signals frustration in a particular sentence rather than by its own
  character, it is "neutral" with category "none". Most two-word phrases are just
  two ordinary words next to each other — say so.
- A word that is merely negative in subject matter ("bug", "error", "fail",
  "failing", "broken", "conflict") is NOT a frustration signal — it describes the
  work, not the user's feeling.
- Names of tools, commands, flags, and file types are NEVER signals — they name
  things, not feelings. "ci", "pr", "gh", "sh", "npm", "json", "git", "diff" are
  all neutral, including when the work around them is going badly.
- Separate emoji that report STATUS from emoji that carry FEELING. Status and UI
  icons — ✅ ❌ 🔀 📝 ⚠️ 🚀 — are neutral: they label an outcome, and in practice
  most arrive from tooling rather than from a person. Only affective emoji count:
  🤬 😤 😡 for frustration, 🎉 👍 ❤️ for praise.

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

/**
 * The user-channel content for one entry. Kept minimal — the entry is the whole
 * input. A phrase uses the same envelope as a word, because it is the same kind
 * of subject: a corpus-wide string whose verdict is cached under its own identity.
 */
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

/**
 * Pull a usable verdict out of a model reply, or `null` if there is none.
 *
 * Prefers the forced tool call, falls back to JSON in the text channel (some
 * providers answer that way), and requires the result to actually *look* like a
 * verdict. The shape check matters: a well-formed object of some other kind would
 * otherwise parse into all-default fields and be cached, corpus-wide and
 * permanently, as "neutral" — indistinguishable from a real judgement.
 */
export function extractVerdict(structured: unknown, text: string): Record<string, unknown> | null {
	const candidates: unknown[] = [];
	if (structured && typeof structured === "object") candidates.push(structured);
	if (text) {
		try {
			candidates.push(extractJsonObject(text));
		} catch {
			/* no JSON in the text channel */
		}
	}
	for (const candidate of candidates) {
		const obj = candidate as Record<string, unknown>;
		if (typeof obj["polarity"] === "string" && VALID_POLARITY.has(obj["polarity"] as string)) return obj;
	}
	return null;
}
