/**
 * Deterministic Re-TRAC structured-state checklist scorer (issue #218).
 *
 * Re-TRAC (Zhang et al., 2026) compresses a trajectory into a structured state
 * whose mandatory facets are: (1) Answer & Analytical Conclusions, (2) Evidence
 * Base & Source Verification — observed evidence plus provenance, and
 * (3) Uncertainties & Exploration Trace — unresolved items, failed attempts,
 * abandoned directions. A compaction can fire at the perfect moment and still
 * drop every decisive cue, so this module grades each compaction summary's
 * text against those facets with no language model:
 *
 *   - `conclusions_present`    — facet 1: the summary carries a substantive
 *     synthesis. Deliberately crude (a minimum-length floor): the honest
 *     deterministic lower bound of "does it hold the analytical conclusions".
 *   - `source_references`      — facet 2: of the source references (paths,
 *     URLs) surfaced in tool output during the cycle being flushed, how many
 *     appear verbatim in the summary — verbatim because "re-openable" is the
 *     bar; a paraphrase that loses the path is a loss.
 *   - `unresolved_items`       — facet 3a: fixed cue lexicon for unresolved /
 *     pending / open work.
 *   - `abandoned_directions`   — facet 3b: fixed cue lexicon for directions
 *     tried and discarded, not just the surviving conclusion.
 *
 * Pure functions only: no session access, no I/O.
 */

import { Type, type Static } from "typebox";
import type { RawLead } from "../uncompleted-leads/extract.js";

/** Fixed cue lexicon for unresolved or still-open work (facet 3). */
const UNRESOLVED_CUES = [
	"unresolved",
	"pending",
	"not yet",
	"todo",
	"open question",
	"still needs",
	"remaining",
	"unknown",
	"blocked on",
	"failed to",
	"couldn't",
	"could not",
	"deferred",
] as const;

/** Fixed cue lexicon for exploration that was tried and discarded (facet 3). */
const ABANDONED_CUES = ["abandoned", "discarded", "dead end", "ruled out", "rejected", "reverted", "backed out", "rolled back", "instead of", "no longer"] as const;

/**
 * A "tried X but Y" span reads as an abandoned direction even when neither word
 * is in the cue list. Bounded so it cannot sweep a whole long paragraph.
 */
const TRIED_BUT_PATTERN = /\btried\b[^.\n]{0,120}?\bbut\b/i;

/** Facet 1 floor: shorter than this, the summary carries no synthesis to grade. */
const MIN_CONCLUSION_CHARS = 60;

export const FacetCoverageSchema = Type.Object({
	conclusions_present: Type.Boolean(),
	source_references: Type.Object({
		total_leads: Type.Number(),
		retained_leads: Type.Number(),
	}),
	unresolved_items: Type.Boolean(),
	abandoned_directions: Type.Boolean(),
});
export type FacetCoverage = Static<typeof FacetCoverageSchema>;

function containsAnyCue(textLower: string, cues: readonly string[]): boolean {
	return cues.some((cue) => textLower.includes(cue));
}

/**
 * Grade one compaction summary against the Re-TRAC facets. `leads` are the
 * source references surfaced in tool output during the cycle this summary
 * replaced; retention counts how many of their values appear verbatim in the
 * summary text.
 */
export function gradeSummaryFacets(summaryText: string, leads: readonly RawLead[]): FacetCoverage {
	const uniqueValues = [...new Set(leads.map((l) => l.value))];
	const retainedLeads = uniqueValues.filter((v) => summaryText.includes(v)).length;
	const textLower = summaryText.toLowerCase();
	return {
		conclusions_present: summaryText.trim().length >= MIN_CONCLUSION_CHARS,
		source_references: {
			total_leads: uniqueValues.length,
			retained_leads: retainedLeads,
		},
		unresolved_items: containsAnyCue(textLower, UNRESOLVED_CUES),
		abandoned_directions: containsAnyCue(textLower, ABANDONED_CUES) || TRIED_BUT_PATTERN.test(summaryText),
	};
}

/**
 * How many of the four checklist items this summary satisfies. Source
 * verification is vacuously satisfied when nothing lead-shaped surfaced in the
 * cycle — there was nothing to retain, so nothing was lost.
 */
export function countCoveredFacets(coverage: FacetCoverage): number {
	return [
		coverage.conclusions_present,
		coverage.source_references.total_leads === 0 || coverage.source_references.retained_leads > 0,
		coverage.unresolved_items,
		coverage.abandoned_directions,
	].filter(Boolean).length;
}
