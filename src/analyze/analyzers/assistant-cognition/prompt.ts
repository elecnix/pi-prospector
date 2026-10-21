/**
 * Prompt and response parsing for assistant-cognition.
 *
 * The model receives one turn — the user message plus the assistant's
 * *separately labeled* thinking trace and response text — and reports four
 * cognitive-state signals:
 *
 *   - confusion   the assistant is lost, missing context, or re-reading without
 *                 progress. Inferred across the turn; carries no quote.
 *   - indecision  flip-flopping between approaches within the turn ("actually,
 *                 let's go back to..."). Structural, inferred; no quote.
 *   - surprise    an expectation violation ("that's odd", "I expected X but got
 *                 Y"). Carries a VERBATIM quote, validated as an exact substring
 *                 of the thinking or response text before it is stored.
 *   - apology     the assistant conceding that it was wrong ("Sorry, my
 *                 mistake"). Carries a VERBATIM quote from the response text,
 *                 validated exactly as a surprise quote is.
 *
 * Every entry carries a mild|moderate|high grade. Empty arrays are valid
 * output: abstention is a first-class answer, never an error.
 */

import { shortHash } from "../../input-hash.js";
import { Type, type Static } from "typebox";

export const COGNITION_PROMPT = `You analyse one turn of a coding-agent session for the ASSISTANT's cognitive state.

You are given three separately labeled texts:
- USER MESSAGE: what was asked.
- THINKING TRACE: the assistant's private reasoning for this turn.
- RESPONSE TEXT: what the assistant actually said/did.

Report up to four kinds of signals by calling the \`record_cognition\` tool:

1. "confusion" — the assistant is lost, missing context it needs, or re-reading
   material without making progress. This is INFERRED across the whole turn;
   do NOT supply a quote for confusion entries.
2. "indecision" — flip-flopping between approaches within this turn ("actually,
   let's go back to...", abandoning plan A mid-way for plan B then returning).
   Structural, also INFERRED; do NOT supply a quote for indecision entries.
3. "surprise" — an expectation violated by something observed ("that's odd",
   "I expected X but got Y"). Each surprise entry MUST carry a "quote": the
   exact verbatim text copied character-for-character from the THINKING TRACE
   or the RESPONSE TEXT shown to you. Never paraphrase, trim, or invent quotes.
4. "apology" — the assistant conceding that it was wrong ("Sorry, my mistake
   — the flag is --repo"). Each apology entry MUST carry a "quote": the exact
   verbatim text copied character-for-character from the RESPONSE TEXT shown to
   you. An apology is the assistant's own concession, not a quotation of the
   user and not a word inside a code snippet.

Every entry grades intensity as exactly one of "mild", "moderate", or "high"
(confusion/indecision use "level"; surprise and apology use "severity") plus a
short "rationale" (one sentence).

Judge only what the text supports. If the turn shows none of these states,
return empty arrays — that is a valid, expected answer. Always respond by
calling the record_cognition tool — never answer in prose.`;

export const COGNITION_PROMPT_HASH = shortHash(COGNITION_PROMPT);

/** Forced-tool-call schema for the cognition phase (reliable structured output). */
export const COGNITION_TOOL = {
	name: "record_cognition",
	description: "Submit the cognitive-state signals observed in one coding-agent turn.",
	parameters: Type.Object({
		confusion: Type.Array(
			Type.Object({
				level: Type.Union([Type.Literal("mild"), Type.Literal("moderate"), Type.Literal("high")]),
				rationale: Type.String({ description: "one short sentence" }),
			}),
		),
		indecision: Type.Array(
			Type.Object({
				level: Type.Union([Type.Literal("mild"), Type.Literal("moderate"), Type.Literal("high")]),
				rationale: Type.String({ description: "one short sentence" }),
			}),
		),
		surprise: Type.Array(
			Type.Object({
				quote: Type.String({ description: "verbatim text from the thinking trace or response" }),
				severity: Type.Union([Type.Literal("mild"), Type.Literal("moderate"), Type.Literal("high")]),
				rationale: Type.String({ description: "one short sentence" }),
			}),
		),
		apology: Type.Array(
			Type.Object({
				quote: Type.String({ description: "verbatim text from the response" }),
				severity: Type.Union([Type.Literal("mild"), Type.Literal("moderate"), Type.Literal("high")]),
				rationale: Type.String({ description: "one short sentence" }),
			}),
		),
	}),
};

/** Max characters of each labeled text rendered into the prompt. */
const SECTION_MAX = 6000;

export interface CognitionInput {
	userText: string;
	thinkingText: string;
	assistantText: string;
}

/**
 * Render one turn's prompt. THINKING TRACE and RESPONSE TEXT are always both
 * present and separately labeled — the distinction between private reasoning
 * and spoken output is the point of the analyzer.
 */
export function buildCognitionPrompt(input: CognitionInput): string {
	return [
		"USER MESSAGE:",
		truncate(input.userText, SECTION_MAX),
		"",
		"THINKING TRACE:",
		truncate(input.thinkingText, SECTION_MAX),
		"",
		"RESPONSE TEXT:",
		truncate(input.assistantText, SECTION_MAX),
	].join("\n");
}

/** One graded confusion observation about the turn (no quote — inferred). */
export const ConfusionEntry = Type.Object({
	level: Type.String(),
	rationale: Type.String(),
});
export type ConfusionEntry = Static<typeof ConfusionEntry>;

/** One graded indecision observation about the turn (no quote — structural). */
export const IndecisionEntry = Type.Object({
	level: Type.String(),
	rationale: Type.String(),
});
export type IndecisionEntry = Static<typeof IndecisionEntry>;

/** One graded surprise observation, carrying a verbatim quote from the turn. */
export const SurpriseEntry = Type.Object({
	quote: Type.String(),
	severity: Type.String(),
	rationale: Type.String(),
});
export type SurpriseEntry = Static<typeof SurpriseEntry>;

/**
 * One graded apology observation (issue #318): the assistant conceding that it
 * was wrong. Carries a VERBATIM quote from the response text, validated the
 * same way a surprise quote is.
 */
export const ApologyEntry = Type.Object({
	quote: Type.String(),
	severity: Type.String(),
	rationale: Type.String(),
});
export type ApologyEntry = Static<typeof ApologyEntry>;

/** The stored classification node content (plus the anchoring user message id). */
export const AssistantCognitionProperties = Type.Object({
	user_message_id: Type.String(),
	confusion: Type.Array(ConfusionEntry),
	indecision: Type.Array(IndecisionEntry),
	surprise: Type.Array(SurpriseEntry),
	apology: Type.Array(ApologyEntry),
	/** The decision model's distribution per question, when that path produced the node (#338). */
	probabilities: Type.Optional(Type.Record(Type.String(), Type.Record(Type.String(), Type.Number()))),
});
export type AssistantCognitionProperties = Static<typeof AssistantCognitionProperties>;

const VALID_LEVELS = new Set(["mild", "moderate", "high"]);

/** Texts a surprise quote is validated against (exact substring required). */
export interface QuoteGrounds {
	thinkingText: string;
	assistantText: string;
}

/** An abstention: no signal found on any axis. A valid analysis result. */
export function emptyCognition(): Pick<AssistantCognitionProperties, "confusion" | "indecision" | "surprise" | "apology"> {
	return { confusion: [], indecision: [], surprise: [], apology: [] };
}

/**
 * Parse arbitrary model text into a cognition result. Throws only when the
 * text contains no JSON object at all — per-entry problems are dropped, not fatal.
 */
export function parseCognitionResponse(text: string, grounds: QuoteGrounds): Pick<AssistantCognitionProperties, "confusion" | "indecision" | "surprise" | "apology"> {
	return parseCognitionObject(extractJsonObject(text), grounds);
}

/**
 * Normalise an already-parsed object (e.g. forced-tool-call arguments) into
 * validated entries.
 *
 * Structural validation drops rather than repairs: an entry whose grade is not
 * mild|moderate|high, whose rationale is missing, or whose quote is not an
 * EXACT substring of the turn's thinking or response text does not enter the
 * graph. Empty arrays pass through — abstention is valid output.
 */
export function parseCognitionObject(obj: Record<string, unknown>, grounds: QuoteGrounds): Pick<AssistantCognitionProperties, "confusion" | "indecision" | "surprise" | "apology"> {
	return {
		confusion: parseGradedEntries(obj["confusion"]),
		indecision: parseGradedEntries(obj["indecision"]),
		surprise: parseSurprises(obj["surprise"], grounds),
		apology: parseApologies(obj["apology"], grounds),
	};
}

function parseGradedEntries(value: unknown): Array<ConfusionEntry | IndecisionEntry> {
	if (!Array.isArray(value)) return [];
	const out: Array<ConfusionEntry | IndecisionEntry> = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object") continue;
		const obj = raw as Record<string, unknown>;
		const level = obj["level"];
		const rationale = obj["rationale"];
		if (typeof level !== "string" || !VALID_LEVELS.has(level)) continue;
		if (typeof rationale !== "string" || rationale.trim().length === 0) continue;
		out.push({ level, rationale: rationale.slice(0, 300) });
	}
	return out;
}

/**
 * Parse the model's surprise entries.
 *
 * A surprise quote is validated against the turn's thinking trace *or* its
 * response text: the stored evidence must be findable verbatim in the turn
 * itself, otherwise it cannot be traced back to the conversation.
 */
function parseSurprises(value: unknown, grounds: QuoteGrounds): SurpriseEntry[] {
	return parseQuotedEntries<SurpriseEntry>(value, (quote) =>
		grounds.thinkingText.includes(quote) || grounds.assistantText.includes(quote),
	);
}

/**
 * Parse the model's apology entries (issue #318).
 *
 * An apology is validated exactly as a surprise is: the quote must be an exact
 * substring of the turn's text, or the entry does not enter the graph. The
 * quote is checked against the **response** text only — an apology is
 * something the assistant said to the user, never a phrase that happened to
 * appear in its private reasoning. A quote found only in the thinking trace is
 * dropped, because it is not evidence the user ever saw.
 */
function parseApologies(value: unknown, grounds: QuoteGrounds): ApologyEntry[] {
	return parseQuotedEntries<ApologyEntry>(value, (quote) => grounds.assistantText.includes(quote));
}

/**
 * The shared shape of a quote-carrying cognition entry: a quote, a severity,
 * and a rationale.
 *
 * Both the surprise and the apology entries have that shape and both are
 * validated the same way — the grade must be mild|moderate|high, the
 * rationale must be present, and the quote must be findable verbatim in the
 * turn. Only the ground the quote is checked against differs, so that check
 * is a parameter rather than a second copy of the loop.
 */
interface QuotedCognitionEntry {
	quote: string;
	severity: string;
	rationale: string;
}

/**
 * Normalise a list of quote-carrying entries, dropping the ones that do not
 * hold up. Structural validation drops rather than repairs: an entry whose
 * grade is invalid, whose rationale is missing, or whose quote is not
 * findable verbatim does not enter the graph.
 */
function parseQuotedEntries<T extends QuotedCognitionEntry>(
	value: unknown,
	isGrounded: (quote: string) => boolean,
): T[] {
	if (!Array.isArray(value)) return [];
	const out: T[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object") continue;
		const obj = raw as Record<string, unknown>;
		const severity = obj["severity"];
		const rationale = obj["rationale"];
		const quote = obj["quote"];
		if (typeof severity !== "string" || !VALID_LEVELS.has(severity)) continue;
		if (typeof rationale !== "string" || rationale.trim().length === 0) continue;
		if (typeof quote !== "string" || quote.length === 0) continue;
		// Quote validation: the stored evidence must be findable verbatim in the
		// turn itself, otherwise it cannot be traced back to the conversation.
		if (!isGrounded(quote)) continue;
		out.push({ quote, severity, rationale: rationale.slice(0, 300) } as T);
	}
	return out;
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Extract the first balanced JSON object from arbitrary model text. */
export function extractJsonObject(text: string): Record<string, unknown> {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	const candidate = fenced ? fenced[1]! : text;
	const start = candidate.indexOf("{");
	if (start < 0) throw new Error("No JSON object found in LLM response");
	let depth = 0;
	for (let i = start; i < candidate.length; i++) {
		const ch = candidate[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				const slice = candidate.slice(start, i + 1);
				return JSON.parse(slice) as Record<string, unknown>;
			}
		}
	}
	throw new Error("Unterminated JSON object in LLM response");
}
