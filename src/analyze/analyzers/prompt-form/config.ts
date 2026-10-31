/**
 * Configuration for the prompt-form analyzer.
 *
 * Every knob is part of the config fingerprint: changing one marks prior nodes
 * stale for the `config` reason.
 */

import { Type, type Static } from "typebox";

export const PromptFormConfig = Type.Object({
	/**
	 * Upper bounds, in characters and ascending, of the length buckets. A prompt
	 * lands in the first bucket whose bound it does not exceed, and a longer one in
	 * the overflow bucket. Bucket counts add across sessions, which medians do not.
	 */
	lengthBoundsChars: Type.Array(Type.Integer({ minimum: 0 })),
	/** List lines (a bullet or a number) a prompt needs to count as a list. */
	listMinLines: Type.Integer({ minimum: 1 }),
	/**
	 * The lowest probability the classifier's answer may have for a prompt to take
	 * that kind. Below it, or with no answer at all, the prompt's kind is `unknown`.
	 */
	minKindConfidence: Type.Number({ minimum: 0, maximum: 1 }),
});
export type PromptFormConfig = Static<typeof PromptFormConfig>;

export const DEFAULT_PROMPT_FORM_CONFIG: PromptFormConfig = {
	lengthBoundsChars: [20, 80, 300, 1000],
	listMinLines: 3,
	minKindConfidence: 0.6,
};
