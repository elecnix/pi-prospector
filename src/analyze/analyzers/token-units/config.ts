/**
 * The unit and its exchange rate.
 *
 * A **MITE** is a Million Input-Token Equivalents. Raw token counts are
 * available on every transcript but are not comparable to one another: an
 * output token costs far more to produce than a cache-read token, so "total
 * tokens" flatters a session that read a large cached prefix and understates one
 * that wrote a lot. MITE fixes the exchange rate once, so a single number means
 * the same thing across providers and across days.
 *
 * Dollars would be the obvious alternative and are not available. Claude Code
 * records no per-message cost at all, and Pi records one only for routes that
 * priced the call, so a dollar-denominated report would silently omit most of a
 * corpus. Tokens are recorded everywhere.
 */

/** Input-token equivalents per token of each kind. */
export interface UnitWeights {
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
}

/** Equivalents in one MITE. */
export const EQUIVALENTS_PER_MITE = 1_000_000;

/**
 * The default rates. `input` is the numeraire by definition. The `cache_write`
 * rate is the one assumption in the set — it is the conventional 1.25× charged
 * for a five-minute cache write — and it is config rather than a constant so a
 * corpus billed differently can restate it. Because weights live in the config,
 * changing one marks existing nodes stale for the `config` reason instead of
 * quietly restating history.
 */
export const DEFAULT_WEIGHTS: UnitWeights = {
	input: 1,
	output: 15,
	cache_read: 0.1,
	cache_write: 1.25,
};

export interface TokenUnitsConfig {
	weights: UnitWeights;
}

export const DEFAULT_TOKEN_UNITS_CONFIG: TokenUnitsConfig = { weights: DEFAULT_WEIGHTS };
