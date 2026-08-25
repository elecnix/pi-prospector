/**
 * Configuration for the uncompleted-leads analyzer.
 *
 * Every knob is part of the config fingerprint (DESIGN.md: everything the user
 * sets is config, and a different config "is just different") — changing any of
 * these marks prior nodes stale for the `config` reason; a plain fill leaves
 * them alone and `--revise config` recomputes them with lineage preserved.
 */

import { Type, type Static } from "typebox";

/** The lead classes the extractor recognises. Deterministic and closed. */
export const LeadTypeSchema = Type.Union([
	Type.Literal("path"),
	Type.Literal("url"),
	Type.Literal("command"),
]);
export type LeadType = Static<typeof LeadTypeSchema>;

export const UncompletedLeadsConfig = Type.Object({
	/**
	 * How many subsequent tool calls after the surfacing call may still count as
	 * pursuing a lead — measured in tool-call ordinals in the session's ordered
	 * action stream, like tool-trajectory's oscillation window. A match beyond
	 * this window does not complete the lead.
	 */
	completionWindow: Type.Integer({ minimum: 1 }),
	/** Which lead classes to extract. Removing one narrows detection via config. */
	enabledTypes: Type.Array(LeadTypeSchema),
	/** Cap on lead records per session, so a grep-heavy result cannot blow up node size. */
	maxLeads: Type.Integer({ minimum: 1 }),
	/**
	 * Minimum number of uncompleted leads of ONE class before that class earns a
	 * proposal. A single uncompleted path is noise; recurring classes are the
	 * signal (the issue's "same lead-class recurs" gate, applied at the scope a
	 * session-level deterministic analyzer can own).
	 */
	minUncompletedForProposal: Type.Integer({ minimum: 1 }),
});
export type UncompletedLeadsConfig = Static<typeof UncompletedLeadsConfig>;

export const DEFAULT_UNCOMPLETED_LEADS_CONFIG: UncompletedLeadsConfig = {
	completionWindow: 10,
	enabledTypes: ["path", "url", "command"],
	maxLeads: 200,
	minUncompletedForProposal: 3,
};
