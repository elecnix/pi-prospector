/**
 * Session scan: grade every compaction summary and diff pre-compaction leads
 * against post-compaction usage (issue #218).
 *
 * The checklist scorer (`checklist.ts`) is the Re-TRAC facet half. This module
 * is the ground-truth half, with no LLM: leads surfaced in tool output during a
 * cycle are extracted with uncompleted-leads' shape-based extractor; a lead
 * that appears verbatim in the summary was *retained*; a lead absent from the
 * summary yet matched by a later tool call before the next flush was *lost* —
 * the agent either lost it or had to re-derive it from scratch.
 *
 * Reads the action stream through the shared seam
 * (`src/analyze/tool-stream.ts`) and reuses uncompleted-leads' pure functions
 * (`extractLeads`, `matchesLead`, `resolvedResultText`) — shared pure logic,
 * no analysis dependency declared (the presidio/piicatcher precedent).
 *
 * Each summary is graded over its own cycle only: leads surfaced strictly after
 * the previous compaction boundary belong to this flush's grading, not an
 * earlier one, and usage is matched strictly after this boundary up to the next
 * one — a call beyond the next flush may have been served by the next summary.
 *
 * Pure and deterministic over the message rows; no I/O.
 */

import { Type, type Static } from "typebox";
import type { MessageRow } from "../../types.js";
import { buildToolStream } from "../../tool-stream.js";
import { matchesLead, resolvedResultText } from "../uncompleted-leads/detect.js";
import { extractLeads, type RawLead } from "../uncompleted-leads/extract.js";
import { DEFAULT_UNCOMPLETED_LEADS_CONFIG, LeadTypeSchema } from "../uncompleted-leads/config.js";
import type { CompressionChecklistConfig } from "./config.js";
import { countCoveredFacets, gradeSummaryFacets, FacetCoverageSchema } from "./checklist.js";

/**
 * The extraction config handed to `extractLeads`. Only `enabledTypes` is read;
 * all three classes are always extracted — which classes matter is decided by
 * matching, not by narrowing extraction here.
 */
const EXTRACTION_CONFIG = { ...DEFAULT_UNCOMPLETED_LEADS_CONFIG };

/** A lead absent from the summary yet used again afterwards — likely lost or re-derived. */
export const LostLeadSchema = Type.Object({
	type: LeadTypeSchema,
	value: Type.String(),
	/** The toolResult message whose text surfaced the lead during the flushed cycle. */
	source_message_id: Type.String(),
	/** The assistant message carrying the first post-compaction call that used it. */
	used_by_message_id: Type.String(),
});
export type LostLead = Static<typeof LostLeadSchema>;

/** One graded compaction summary. */
export const SummaryGradeSchema = Type.Object({
	message_id: Type.String(),
	/** Position of the summary row in the ordered message stream. */
	message_ordinal: Type.Number(),
	facet_coverage: FacetCoverageSchema,
	covered_facet_count: Type.Number(),
	/** Distinct source references surfaced in tool output during the flushed cycle. */
	leads_total: Type.Number(),
	/** Of those, how many appear verbatim in the summary text. */
	leads_retained: Type.Number(),
	leads_lost: Type.Array(LostLeadSchema),
});
export type SummaryGrade = Static<typeof SummaryGradeSchema>;

interface SurfacedLead extends RawLead {
	source_message_id: string;
}

/**
 * Grade every `compactionSummary` row in the session. Returns one grade per
 * summary in stream order; empty when the session never compacted (the caller
 * — plan() — then plans no unit at all).
 */
export function scanSessionChecklist(
	messages: readonly MessageRow[],
	config: CompressionChecklistConfig,
): SummaryGrade[] {
	const indexById = new Map(messages.map((m, i) => [m.id, i] as const));
	const summaryIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i]!.role === "compactionSummary") summaryIndices.push(i);
	}
	if (summaryIndices.length === 0) return [];

	const stream = buildToolStream([...messages]);
	const messagesById = new Map(messages.map((m) => [m.id, m]));

	const grades: SummaryGrade[] = [];
	for (let si = 0; si < summaryIndices.length; si++) {
		const flushIndex = summaryIndices[si]!;
		const prevIndex = si > 0 ? summaryIndices[si - 1]! : -1;
		const nextIndex = si < summaryIndices.length - 1 ? summaryIndices[si + 1]! : messages.length;

		const summaryRow = messages[flushIndex]!;
		const summaryText = summaryRow.content_text ?? "";

		// Leads surfaced strictly inside this cycle: (prevIndex, flushIndex).
		const seenValues = new Set<string>();
		const leads: SurfacedLead[] = [];
		for (const inv of stream.invocations) {
			const msgIndex = indexById.get(inv.messageId);
			if (msgIndex === undefined || msgIndex <= prevIndex || msgIndex >= flushIndex) continue;
			const text = resolvedResultText(inv, messagesById);
			if (text === null) continue;
			for (const raw of extractLeads(text, EXTRACTION_CONFIG)) {
				if (seenValues.has(raw.value)) continue;
				seenValues.add(raw.value);
				if (leads.length >= config.maxLeadsPerSummary) continue;
				leads.push({ ...raw, source_message_id: inv.outcome!.messageId });
			}
		}

		// Lost: absent verbatim from the summary, yet matched by a call strictly
		// after this flush and before the next one.
		const lostLeads: LostLead[] = [];
		for (const lead of leads) {
			if (summaryText.includes(lead.value)) continue;
			let usedByMessageId: string | null = null;
			for (const inv of stream.invocations) {
				const msgIndex = indexById.get(inv.messageId);
				if (msgIndex === undefined || msgIndex <= flushIndex || msgIndex >= nextIndex) continue;
				if (matchesLead(lead.type, lead.value, inv)) {
					usedByMessageId = inv.messageId;
					break;
				}
			}
			if (usedByMessageId !== null) {
				lostLeads.push({
					type: lead.type,
					value: lead.value,
					source_message_id: lead.source_message_id,
					used_by_message_id: usedByMessageId,
				});
			}
		}

		const leadsRetained = leads.filter((l) => summaryText.includes(l.value)).length;
		const facetCoverage = gradeSummaryFacets(summaryText, leads);
		grades.push({
			message_id: summaryRow.id,
			message_ordinal: flushIndex,
			facet_coverage: facetCoverage,
			covered_facet_count: countCoveredFacets(facetCoverage),
			leads_total: leads.length,
			leads_retained: leadsRetained,
			leads_lost: lostLeads,
		});
	}

	return grades;
}
