/**
 * Configuration for the attention-gaps analyzer.
 *
 * Every knob is part of the config fingerprint: changing one marks prior nodes
 * stale for the `config` reason.
 */

import { Type, type Static } from "typebox";

export const AttentionGapsConfig = Type.Object({
	/**
	 * Upper bounds, in seconds and ascending, of the gap buckets. A gap lands in
	 * the first bucket whose bound it does not exceed, and a longer one in the
	 * overflow bucket. Chosen to separate a reply in the flow of work (seconds)
	 * from a return after the operator went away (hours).
	 */
	bucketBoundsSeconds: Type.Array(Type.Number({ minimum: 0 })),
	/** How many of the longest gaps are listed with their message, as evidence. */
	longestCap: Type.Integer({ minimum: 0 }),
});
export type AttentionGapsConfig = Static<typeof AttentionGapsConfig>;

export const DEFAULT_ATTENTION_GAPS_CONFIG: AttentionGapsConfig = {
	bucketBoundsSeconds: [10, 60, 300, 1800, 7200],
	longestCap: 5,
};
