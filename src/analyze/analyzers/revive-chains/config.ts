/**
 * Configuration for the revive-chains analyzer.
 *
 * The one knob decides when a revive chain stops being an observation and
 * becomes a finding worth proposing on. A chain of length L means L spawns for
 * one logical child conversation, so even L = 2 already contains one spawn that
 * a persistent multi-turn primitive would not have paid — but the default is
 * deliberately the smallest finding-worthy chain, and an operator who wants the
 * analyzer to stay quiet until the waste is unambiguous can raise it.
 */

import { Type, type Static } from "typebox";

export const ReviveChainsConfig = Type.Object({
	/**
	 * Minimum chain length (consecutive revived subagent results) before the
	 * node carries a remedy proposal. Shorter chains are still measured and
	 * reported as metrics.
	 */
	minChainLength: Type.Integer({ minimum: 2 }),
});
export type ReviveChainsConfig = Static<typeof ReviveChainsConfig>;

export const DEFAULT_REVIVE_CHAINS_CONFIG: ReviveChainsConfig = {
	minChainLength: 2,
};
