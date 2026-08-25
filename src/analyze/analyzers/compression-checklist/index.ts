/**
 * compression-checklist — deterministic session-level grading of compaction
 * summaries against the Re-TRAC structured-state checklist (issue #218).
 *
 * A compaction can fire at the perfect moment and still drop every decisive
 * cue, so this analyzer grades each `compactionSummary` (the normalized
 * compaction-boundary role from #150) on two axes, both with no LLM:
 *
 *   1. **Facet coverage** — does the summary satisfy Re-TRAC's mandatory
 *      facets? Does it name unresolved items? Does it retain source references
 *      (paths, URLs) verbatim enough to be re-openable? Does it record
 *      abandoned directions, or only conclusions? (`checklist.ts`)
 *   2. **Ground-truth loss** — leads surfaced in tool output during the flushed
 *      cycle are extracted with uncompleted-leads' shape-based extractor and
 *      diffed against post-compaction tool calls: a lead absent from the
 *      summary yet used again afterwards was likely lost or had to be
 *      re-derived. (`detect.ts`)
 *
 * Why a sibling analyzer rather than an extension of context-economy: that
 * analyzer's identity is token *accounting* — carry cost, flush timing, rebuild
 * cost. Grading summary *content* is a different subject over different
 * evidence (summary text plus lead extraction). The compaction boundary is a
 * conversation fact — a message role — not derived analysis, so this analyzer
 * reads it directly from the transcript instead of declaring a dependency whose
 * output it does not consume; folding the grading into context-economy would
 * conflate the two subjects in one node and force a major version bump on a
 * token-accounting analyzer (#67's precedent applies to extending it, which we
 * deliberately do not do).
 *
 * One node per session. Metric by default; when lost leads recur above the
 * config threshold the node carries `improvement_proposals` and is emitted as
 * kind `proposal`, following the failure-modes / uncompleted-leads convention
 * for deterministic analyzers.
 */

import type {
	Analyzer,
	AnalyzerDef,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	AnalysisResult,
	AnalysisUnit,
	MessageRow,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeConfigHash, shortHash } from "../../input-hash.js";
import { buildToolStream } from "../../tool-stream.js";
import { resolvedResultText } from "../uncompleted-leads/detect.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { Type, type Static } from "typebox";
import {
	DEFAULT_COMPRESSION_CHECKLIST_CONFIG,
	type CompressionChecklistConfig,
} from "./config.js";
import { scanSessionChecklist, SummaryGradeSchema } from "./detect.js";

/** A proposal this analyzer embeds in its node; materialised by the framework. */
export const CompressionChecklistRawProposal = Type.Object({
	target_type: Type.String(),
	target_path: Type.Optional(Type.String()),
	title: Type.String(),
	summary: Type.String(),
	detail: Type.String(),
	evidence: Type.String(),
	confidence: Type.Number(),
	severity: Type.String(),
});
export type CompressionChecklistRawProposal = Static<typeof CompressionChecklistRawProposal>;

/** The properties a compression-checklist node carries in its `contentJson`. */
export const COMPRESSION_CHECKLIST_PROPERTIES = Type.Object({
	session_id: Type.String(),
	summaries: Type.Array(SummaryGradeSchema),
	summary_count: Type.Number(),
	/** Summaries satisfying all four checklist items. */
	fully_covered_count: Type.Number(),
	/** Lost leads across all summaries — absent from the summary yet used again after it. */
	leads_lost_count: Type.Number(),
	improvement_proposals: Type.Array(CompressionChecklistRawProposal),
});
export type CompressionChecklistProperties = Static<typeof COMPRESSION_CHECKLIST_PROPERTIES>;

export const COMPRESSION_CHECKLIST_DEF: AnalyzerDef = {
	id: "compression-checklist",
	label: "Compression Checklist (Re-TRAC)",
	description:
		"Grades each compactionSummary against Re-TRAC's structured-state checklist — unresolved items, verbatim source references, abandoned directions — and diffs pre-compaction leads against post-compaction tool calls to find decisive cues the summary dropped. Deterministic, no LLM.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: COMPRESSION_CHECKLIST_PROPERTIES,
};

export const COMPRESSION_CHECKLIST_VERSION: AnalyzerVersion = {
	analyzerId: COMPRESSION_CHECKLIST_DEF.id,
	// 1.0 (issue #218): per-summary Re-TRAC facet coverage (conclusions present,
	// verbatim source-reference retention, unresolved-item cues, abandoned-
	// direction cues) plus ground-truth lead-loss detection over each compaction
	// cycle, with a recurrence-gated proposal.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/compression-checklist/index.ts",
};

function resolveConfig(raw: unknown): CompressionChecklistConfig {
	return (raw as CompressionChecklistConfig) ?? DEFAULT_COMPRESSION_CHECKLIST_CONFIG;
}

/**
 * Fingerprint of everything this analyzer reads: the compaction summaries'
 * texts and the tool-result texts leads are extracted from. Hashing the texts
 * themselves (not just which rows exist) makes a re-sync that backfills result
 * text re-identify as missing and recompute — the same trade uncompleted-leads
 * makes for its result texts.
 */
function compressionFingerprint(messages: readonly MessageRow[]): string {
	const stream = buildToolStream([...messages]);
	const messagesById = new Map(messages.map((m) => [m.id, m]));
	const lines: string[] = [];
	for (const m of messages) {
		if (m.role === "compactionSummary") {
			const text = m.content_text ?? "";
			lines.push(`s:${m.id}:${text.length}:${shortHash(text)}`);
		}
	}
	for (const inv of stream.invocations) {
		if (!inv.outcome) continue;
		const text = resolvedResultText(inv, messagesById);
		lines.push(`r:${inv.ordinal}:${inv.name}:${text === null ? "" : text.length}:${text === null ? "" : shortHash(text)}`);
	}
	return shortHash(lines.join("\n"));
}

const LOST_LEAD_EXAMPLE_CAP = 5;

function buildProposal(
	totalLost: number,
	lostValues: string[],
): CompressionChecklistRawProposal {
	return {
		target_type: "agents_md",
		title: `Compaction summaries dropped ${totalLost} lead${totalLost === 1 ? "" : "s"} the agent needed again`,
		summary: `${totalLost} file path(s)/URL(s)/command(s) surfaced in tool output before a compaction were absent from the summary yet were used again afterwards — evidence they were lost in compression or had to be re-derived.`,
		detail:
			"Add a standing instruction for what compaction summaries must retain (Re-TRAC's structured state): the open questions and failed attempts still live, the source references verbatim enough to be re-opened, and the abandoned directions so they are not retried. A summary that keeps only conclusions silently discards the working state the next turn depends on.",
		evidence: `Lost leads (up to ${LOST_LEAD_EXAMPLE_CAP} of ${totalLost}): ${lostValues.join(", ")}`,
		confidence: 0.6,
		severity: "waste",
	};
}

export const compressionChecklistAnalyzer: Analyzer = {
	def: COMPRESSION_CHECKLIST_DEF,
	version: COMPRESSION_CHECKLIST_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: COMPRESSION_CHECKLIST_DEF.id,
		configHash: computeConfigHash(DEFAULT_COMPRESSION_CHECKLIST_CONFIG),
		configJson: DEFAULT_COMPRESSION_CHECKLIST_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		// A session that never compacted has nothing for this analyzer to grade.
		if (!ctx.messages.some((m) => m.role === "compactionSummary")) return [];

		const fingerprint = compressionFingerprint(ctx.messages);
		const sources: SourceRef[] = [{ kind: "session", id: `${ctx.sessionId}#retrac=${fingerprint}` }];
		return [
			{
				sources,
				sourceSetHash: shortHash(`compression-checklist(${ctx.sessionId}|${fingerprint})`),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
			},
		];
	},

	async analyze(_unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		const summaries = scanSessionChecklist(messages, config);

		let totalLost = 0;
		const lostValues: string[] = [];
		for (const s of summaries) {
			for (const lead of s.leads_lost) {
				totalLost++;
				if (lostValues.length < LOST_LEAD_EXAMPLE_CAP) lostValues.push(lead.value);
			}
		}

		const proposals: CompressionChecklistRawProposal[] =
			totalLost >= config.minLostLeadsForProposal ? [buildProposal(totalLost, lostValues)] : [];

		const properties: CompressionChecklistProperties = {
			session_id: ctx.sessionId,
			summaries,
			summary_count: summaries.length,
			fully_covered_count: summaries.filter((s) => s.covered_facet_count === 4).length,
			leads_lost_count: totalLost,
			improvement_proposals: proposals,
		};

		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
		];
		// Anchor each graded summary, then each message whose result left a lead
		// stranded, so the finding walks back to the exact words that were dropped.
		let ordinal = 1;
		const anchored = new Set<string>();
		for (const grade of summaries) {
			if (anchored.has(grade.message_id)) continue;
			anchored.add(grade.message_id);
			edges.push({ toRefKind: REF_KINDS.MESSAGE, toRefId: grade.message_id, edgeKind: EDGE_KINDS.ANCHORS, ordinal: ordinal++ });
		}
		for (const grade of summaries) {
			for (const lead of grade.leads_lost) {
				if (anchored.has(lead.source_message_id)) continue;
				anchored.add(lead.source_message_id);
				edges.push({ toRefKind: REF_KINDS.MESSAGE, toRefId: lead.source_message_id, edgeKind: EDGE_KINDS.ANCHORS, ordinal: ordinal++ });
			}
		}

		return {
			nodeKind: proposals.length > 0 ? "proposal" : "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			edges,
		};
	},
};
