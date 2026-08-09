/**
 * Config for the routing-opportunity analyzer.
 */

export interface RoutingConfig {
	/** A turn with at most this many tool calls counts as easy (all markers must hold). */
	easyToolCallMax: number;
	/** A turn whose context (input + cacheRead) is at most this many tokens counts as easy. */
	easyContextTokensMax: number;
	/** A turn whose edit size is at most this many chars counts as easy. */
	easyEditCharsMax: number;
}

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
	easyToolCallMax: 2,
	easyContextTokensMax: 20000,
	easyEditCharsMax: 2000,
};
