/**
 * Prompt form: the shape of what a person typed.
 *
 * Form is read from the person's own words only. The `message-origin` nodes say
 * which messages a person typed, and `labelUserText` cuts the pasted blocks,
 * quotes, and harness envelopes out of a typed message, so a prompt with a log
 * pasted under it is measured by the sentence the person wrote.
 *
 * The kind of a prompt (question, instruction, correction, other) is a
 * classifier answer from `message-answers`, read in any language. A prompt with
 * no answer, or an answer below the configured confidence, has the kind
 * `unknown`: not a guess, and not zero.
 */

import { Type, type Static } from "typebox";
import { labelUserText } from "../../text-origin.js";
import { DEFAULT_PROMPT_FORM_CONFIG, type PromptFormConfig } from "./config.js";

export const PromptKindOrUnknown = Type.Union([
	Type.Literal("question"),
	Type.Literal("instruction"),
	Type.Literal("correction"),
	Type.Literal("other"),
	Type.Literal("unknown"),
]);
export type PromptKindOrUnknown = Static<typeof PromptKindOrUnknown>;

/** What the scan needs to know about one typed prompt. */
export const TypedPrompt = Type.Object({
	/** The message's full text. */
	text: Type.String(),
	/** The classifier's kind, or `unknown`. */
	kind: PromptKindOrUnknown,
});
export type TypedPrompt = Static<typeof TypedPrompt>;

export const PromptShape = Type.Object({
	kind: PromptKindOrUnknown,
	chars: Type.Number(),
	/** The person's own words held a bullet or numbered list of at least the configured size. */
	has_list: Type.Boolean(),
	/** The person's own words held a markdown heading. */
	has_heading: Type.Boolean(),
	/** The message held a fenced code block, whoever wrote it. */
	has_code_block: Type.Boolean(),
});
export type PromptShape = Static<typeof PromptShape>;

const LIST_LINE = /^\s*(?:[-*•]|\d+[.)])\s+\S/;
const HEADING_LINE = /^\s{0,3}#{1,6}\s+\S/;

/** The shape of one typed prompt, or null when none of its words were the person's own. */
export function shapeOf(prompt: TypedPrompt, config: PromptFormConfig = DEFAULT_PROMPT_FORM_CONFIG): PromptShape | null {
	const own = labelUserText(prompt.text, { role: "user", childAgent: false, forkCopy: false })
		.filter((span) => span.origin === "typed")
		.map((span) => span.text)
		.join("\n")
		.trim();
	if (own === "") return null;
	const lines = own.split("\n");
	return {
		kind: prompt.kind,
		chars: own.length,
		has_list: lines.filter((l) => LIST_LINE.test(l)).length >= config.listMinLines,
		has_heading: lines.some((l) => HEADING_LINE.test(l)),
		has_code_block: /^\s*```/m.test(prompt.text),
	};
}

export const LengthBucket = Type.Object({
	/** Upper bound in characters, or null for the overflow bucket. */
	le_chars: Type.Union([Type.Number(), Type.Null()]),
	count: Type.Number(),
});
export type LengthBucket = Static<typeof LengthBucket>;

export const PromptFormScan = Type.Object({
	/** Messages settled as typed. */
	typed_message_count: Type.Number(),
	/** Typed messages with none of the person's own words after pasted and quoted text is cut. */
	no_own_words_count: Type.Number(),
	/** Messages whose origin is provisional; their form is not read. */
	undecided_message_count: Type.Number(),
	kinds: Type.Record(PromptKindOrUnknown, Type.Number()),
	sum_chars: Type.Number(),
	median_chars: Type.Union([Type.Number(), Type.Null()]),
	p90_chars: Type.Union([Type.Number(), Type.Null()]),
	max_chars: Type.Union([Type.Number(), Type.Null()]),
	length_buckets: Type.Array(LengthBucket),
	list_count: Type.Number(),
	heading_count: Type.Number(),
	code_block_count: Type.Number(),
});
export type PromptFormScan = Static<typeof PromptFormScan>;

function nearestRank(sorted: readonly number[], p: number): number | null {
	if (sorted.length === 0) return null;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

/** Fold the shapes of a session's typed prompts. */
export function scanPromptForm(
	prompts: readonly TypedPrompt[],
	undecided: number,
	config: PromptFormConfig = DEFAULT_PROMPT_FORM_CONFIG,
): PromptFormScan {
	const shapes: PromptShape[] = [];
	let noOwn = 0;
	for (const p of prompts) {
		const shape = shapeOf(p, config);
		if (shape === null) noOwn++;
		else shapes.push(shape);
	}
	const kinds: Record<PromptKindOrUnknown, number> = { question: 0, instruction: 0, correction: 0, other: 0, unknown: 0 };
	for (const s of shapes) kinds[s.kind]++;

	const chars = shapes.map((s) => s.chars).sort((a, b) => a - b);
	const bounds = [...config.lengthBoundsChars].sort((a, b) => a - b);
	const buckets: LengthBucket[] = [...bounds.map((le) => ({ le_chars: le as number | null, count: 0 })), { le_chars: null, count: 0 }];
	for (const c of chars) {
		const bucket = buckets.find((b) => b.le_chars === null || c <= b.le_chars);
		if (bucket) bucket.count++;
	}
	return {
		typed_message_count: prompts.length,
		no_own_words_count: noOwn,
		undecided_message_count: undecided,
		kinds,
		sum_chars: chars.reduce((n, c) => n + c, 0),
		median_chars: nearestRank(chars, 0.5),
		p90_chars: nearestRank(chars, 0.9),
		max_chars: chars[chars.length - 1] ?? null,
		length_buckets: buckets,
		list_count: shapes.filter((s) => s.has_list).length,
		heading_count: shapes.filter((s) => s.has_heading).length,
		code_block_count: shapes.filter((s) => s.has_code_block).length,
	};
}
