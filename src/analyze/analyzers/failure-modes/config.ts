/**
 * Configuration for the failure-modes analyzer.
 *
 * The thresholds decide when a repeated failure stops being weather and starts
 * being a finding. They are config, not constants, because the right number
 * depends on how the operator works: a corpus of short sessions and a corpus of
 * eight-hour ones do not agree on what "three failures" means.
 */

import { Type, type Static } from "typebox";

export const FailureModesConfig = Type.Object({
	/**
	 * Minimum turn failures of one class before it earns a proposal. A single
	 * transient provider error is not a finding; proposing on it teaches the
	 * reader to skim past the output.
	 */
	minTurnFailures: Type.Integer({ minimum: 1 }),
	/** Minimum tool failures of one class, for one tool, before it earns a proposal. */
	minToolFailures: Type.Integer({ minimum: 1 }),
	/**
	 * Whether to recommend published extensions at all. Turning this off keeps
	 * every measurement and drops every package pointer — for an operator who
	 * wants the diagnosis without the shopping list.
	 */
	recommendExtensions: Type.Boolean(),
});
export type FailureModesConfig = Static<typeof FailureModesConfig>;

export const DEFAULT_FAILURE_MODES_CONFIG: FailureModesConfig = {
	minTurnFailures: 3,
	minToolFailures: 3,
	recommendExtensions: true,
};
