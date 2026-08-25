/**
 * Configuration for the compression-checklist analyzer (issue #218).
 *
 * Every knob is part of the config fingerprint, exactly like every other
 * analyzer's config: changing one marks prior nodes stale for the `config`
 * reason; a plain fill leaves them alone and `--revise config` recomputes them
 * with lineage preserved.
 */

import { Type, type Static } from "typebox";

export const CompressionChecklistConfig = Type.Object({
	/**
	 * Cap on graded leads per compaction summary. A cycle whose tool results
	 * surface more than this many paths/URLs/commands has the excess counted
	 * (`leads_truncated`) rather than silently dropped — the same honesty rule
	 * uncompleted-leads applies to `maxLeads`.
	 */
	maxLeadsPerSummary: Type.Integer({ minimum: 1 }),
	/**
	 * Minimum number of lost leads across the session before it earns a
	 * proposal. One dropped path may have been idle; several leads that had to
	 * be re-derived after a flush are a pattern worth encoding as a standing
	 * instruction about what compaction summaries must retain.
	 */
	minLostLeadsForProposal: Type.Integer({ minimum: 1 }),
});
export type CompressionChecklistConfig = Static<typeof CompressionChecklistConfig>;

export const DEFAULT_COMPRESSION_CHECKLIST_CONFIG: CompressionChecklistConfig = {
	maxLeadsPerSummary: 200,
	minLostLeadsForProposal: 2,
};
