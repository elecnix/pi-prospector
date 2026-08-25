/**
 * uncompleted-leads — deterministic session-level uncompleted-lead detection
 * (issue #216, from Re-TRAC's "Uncompleted Proposals" audit facet).
 *
 * Where the trajectory analyzers detect wasted work that HAPPENED (stuck-loops,
 * oscillation), this analyzer detects valuable work that NEVER happened: leads
 * surfaced in tool output — file paths in grep hits and error payloads, URLs
 * printed in results, suggested commands — that no subsequent call ever pursued.
 *
 * Extraction and matching are fully deterministic (no LLM): leads come from
 * shape-based extraction over tool-result text read through the shared action
 * stream (`src/analyze/tool-stream.ts`), and a lead is completed when a matching
 * later tool call appears within the configured window.
 *
 * One node per session. Metric by default; when a lead class recurs above the
 * config threshold the node carries `improvement_proposals` and is emitted as
 * kind `proposal`, following the failure-modes convention for deterministic
 * analyzers — the framework materialises those into the proposal store, where
 * recurring classes across sessions surface side by side at review time
 * (DESIGN.md: cross-session consolidation stays out of scope).
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
import {
	DEFAULT_UNCOMPLETED_LEADS_CONFIG,
	LeadTypeSchema,
	type UncompletedLeadsConfig,
} from "./config.js";
import { scanSessionLeads, resolvedResultText } from "./detect.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { Type, type Static } from "typebox";

/** A proposal this analyzer embeds in its node; materialised by the framework. */
export const UncompletedLeadsRawProposal = Type.Object({
	target_type: Type.String(),
	target_path: Type.Optional(Type.String()),
	title: Type.String(),
	summary: Type.String(),
	detail: Type.String(),
	evidence: Type.String(),
	confidence: Type.Number(),
	severity: Type.String(),
});
export type UncompletedLeadsRawProposal = Static<typeof UncompletedLeadsRawProposal>;

export const UNCOMPLETED_LEADS_PROPERTIES = Type.Object({
	session_id: Type.String(),
	/** Every surfaced lead, each with its completion verdict. */
	leads: Type.Array(Type.Object({
		type: LeadTypeSchema,
		value: Type.String(),
		source_message_id: Type.String(),
		tool_call_ordinal: Type.Number(),
		status: Type.Union([Type.Literal("completed"), Type.Literal("uncompleted")]),
		completed_by_message_id: Type.Union([Type.String(), Type.Null()]),
	})),
	lead_count: Type.Number(),
	completed_count: Type.Number(),
	uncompleted_count: Type.Number(),
	/** Uncompleted leads per class — the recurrence gate reads this. */
	uncompleted_by_type: Type.Record(Type.String(), Type.Number()),
	/** Lead records dropped by the maxLeads cap — counted, never silently lost. */
	truncated_leads: Type.Number(),
	/** Tool calls whose result carried usable text (extraction coverage). */
	results_with_text: Type.Number(),
	/** Total tool calls analysed (the completion window's denominator). */
	tool_call_count: Type.Number(),
	improvement_proposals: Type.Array(UncompletedLeadsRawProposal),
});
export type UncompletedLeadsProperties = Static<typeof UNCOMPLETED_LEADS_PROPERTIES>;

export const UNCOMPLETED_LEADS_DEF: AnalyzerDef = {
	id: "uncompleted-leads",
	label: "Uncompleted Leads (deterministic)",
	description:
		"Detects leads surfaced in tool output but never pursued — file paths in grep hits, error payloads and test output, URLs printed in results, suggested commands — by extracting them deterministically from the shared action stream and matching each against subsequent tool calls within a configurable window. No LLM.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: UNCOMPLETED_LEADS_PROPERTIES,
};

export const UNCOMPLETED_LEADS_VERSION: AnalyzerVersion = {
	analyzerId: UNCOMPLETED_LEADS_DEF.id,
	// 1.0 (issue #216): deterministic lead extraction (paths, URLs, suggested
	// commands) from single-result tool rows read through the shared action
	// stream, literal completion matching within a tool-call window, per-class
	// recurrence-gated proposals, and a capped per-session lead list.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/uncompleted-leads/index.ts",
};

function resolveConfig(raw: unknown): UncompletedLeadsConfig {
	return (raw as UncompletedLeadsConfig) ?? DEFAULT_UNCOMPLETED_LEADS_CONFIG;
}

const PROPOSAL_TITLES: Record<string, string> = {
	path: "File paths surfaced but never opened",
	url: "URLs surfaced but never fetched",
	command: "Commands suggested by output but never run",
};

const PROPOSAL_REMEDIES: Record<string, string> = {
	path:
		"Add a standing instruction to open (or explicitly dismiss) every file path a tool result surfaces before moving on — grep hits and error payloads name files the task usually depends on.",
	url:
		"Add a standing instruction to fetch or bookmark any URL a tool result prints instead of letting it scroll past — documentation references are cheap to check and expensive to rediscover.",
	command:
		"Add a standing instruction to try commands that tool output itself suggests (\"run `npm install x` to fix\") or record why they were skipped.",
};

/**
 * Build at most one proposal per qualifying lead class. The gate is recurrence:
 * a class must recur above the configured threshold before it earns a proposal,
 * because a single uncompleted path is noise and proposing on noise trains the
 * reader to ignore the output.
 */
function buildProposals(
	scan: ReturnType<typeof scanSessionLeads>,
	config: UncompletedLeadsConfig,
): UncompletedLeadsRawProposal[] {
	const uncompletedByType = new Map<string, string[]>();
	for (const lead of scan.leads) {
		if (lead.status !== "uncompleted") continue;
		const values = uncompletedByType.get(lead.type) ?? [];
		if (values.length < 5) values.push(lead.value);
		uncompletedByType.set(lead.type, values);
	}

	const proposals: UncompletedLeadsRawProposal[] = [];
	for (const [type, values] of [...uncompletedByType.entries()].sort()) {
		const total = scan.leads.filter((l) => l.type === type && l.status === "uncompleted").length;
		if (total < config.minUncompletedForProposal) continue;
		proposals.push({
			target_type: "agents_md",
			title: PROPOSAL_TITLES[type] ?? `${type}s surfaced but never pursued`,
			summary: `${total} ${type} lead${total === 1 ? "" : "s"} surfaced in tool output and never followed up in this session.`,
			detail:
				(PROPOSAL_REMEDIES[type] ?? `Add a standing instruction to pursue surfaced ${type}s.`) +
				" The agent kept surfacing these and never acted on them — work that never happened, invisible to repetition detectors.",
			evidence: `Uncompleted ${type} leads (up to 5 of ${total}): ${values.join(", ")}`,
			confidence: 0.6,
			severity: "waste",
		});
	}
	return proposals;
}

/**
 * Fingerprint of the lead-bearing content, so identity folds in what the
 * results SAID, not merely which messages exist. A re-sync that backfills
 * result text leaves message ids unchanged; hashing the resolved result texts
 * makes the unit re-identify as missing and recompute, which is what actually
 * happened (the same trade failure-modes makes for error text). The texts are
 * hashed raw, never normalised: here the path/URL IS the content.
 *
 * Deliberately conversation-only: config (window, enabled types) is NOT folded
 * in here — it belongs to the framework's config-fingerprint identity axis, so
 * changing a threshold marks prior nodes stale for the `config` reason with
 * lineage preserved, instead of re-identifying as missing.
 */
function leadContentFingerprint(messages: readonly MessageRow[]): string {
	const stream = buildToolStream([...messages]);
	const messagesById = new Map(messages.map((m) => [m.id, m]));
	const lines: string[] = [];
	for (const inv of stream.invocations) {
		if (!inv.outcome) continue;
		const text = resolvedResultText(inv, messagesById);
		lines.push(`r:${inv.ordinal}:${inv.name}:${text === null ? "" : text.length}:${text === null ? "" : shortHash(text)}`);
	}
	lines.push(`n:${stream.coverage.toolCallCount}`);
	return shortHash(lines.join("\n"));
}

export const uncompletedLeadsAnalyzer: Analyzer = {
	def: UNCOMPLETED_LEADS_DEF,
	version: UNCOMPLETED_LEADS_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: UNCOMPLETED_LEADS_DEF.id,
		configHash: computeConfigHash(DEFAULT_UNCOMPLETED_LEADS_CONFIG),
		configJson: DEFAULT_UNCOMPLETED_LEADS_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		// No conversation → no action stream → nothing to extract from. (A clean
		// session with tool traffic still gets a node; only an empty one gets none.)
		if (ctx.messages.length === 0) return [];

		const fingerprint = leadContentFingerprint(ctx.messages);
		const sources: SourceRef[] = [{ kind: "session", id: `${ctx.sessionId}#leads=${fingerprint}` }];
		return [
			{
				sources,
				sourceSetHash: shortHash(`uncompleted-leads(${ctx.sessionId}|${fingerprint})`),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
			},
		];
	},

	async analyze(_unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		const scan = scanSessionLeads(messages, config);

		const completedCount = scan.leads.filter((l) => l.status === "completed").length;
		const uncompletedByType: Record<string, number> = {};
		for (const lead of scan.leads) {
			if (lead.status !== "uncompleted") continue;
			uncompletedByType[lead.type] = (uncompletedByType[lead.type] ?? 0) + 1;
		}
		const proposals = buildProposals(scan, config);

		const properties: UncompletedLeadsProperties = {
			session_id: ctx.sessionId,
			leads: scan.leads,
			lead_count: scan.leads.length,
			completed_count: completedCount,
			uncompleted_count: scan.leads.length - completedCount,
			uncompleted_by_type: uncompletedByType,
			truncated_leads: scan.truncatedLeads,
			results_with_text: scan.resultsWithText,
			tool_call_count: scan.leads.reduce((max, l) => Math.max(max, l.tool_call_ordinal + 1), 0),
			improvement_proposals: proposals,
		};

		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
		];
		// Anchor to each message whose result left a lead unpursued, so the finding
		// walks back to the exact turn where the opportunity appeared.
		let ordinal = 1;
		const anchored = new Set<string>();
		for (const lead of scan.leads) {
			if (lead.status !== "uncompleted") continue;
			if (anchored.has(lead.source_message_id)) continue;
			anchored.add(lead.source_message_id);
			edges.push({ toRefKind: REF_KINDS.MESSAGE, toRefId: lead.source_message_id, edgeKind: EDGE_KINDS.ANCHORS, ordinal: ordinal++ });
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
