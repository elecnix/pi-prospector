/**
 * repetition-collapse — deterministic detection of a step whose own text loops
 * until it exhausts its budget (issue #278).
 *
 * The model repeats a phrase or a sub-word fragment thousands of times, and the
 * pipeline records an ordinary step that happens to be very long. Nothing else
 * sees it: tool-trajectory reads loops in the *actions* across steps, and a
 * single step's reasoning is one text, not a sequence of calls.
 *
 * Each assistant step's reasoning and answer are scored by two cheap ratios
 * (`detect.ts`) — word n-gram repetition and the longest run of a short
 * character motif — because each is blind to the other's loops. Length is only
 * a floor below which nothing is judged; the trigger is the ratio, since most
 * long steps are long analyses that do not repeat at all.
 *
 * The expensive case is a collapsed step that delivered nothing: no answer and
 * no tool call, billed in full, while the session carries on as though it were
 * normal. That is a routing signal — this model loops on this kind of turn —
 * so the proposal targets model configuration, and routing-opportunity reads
 * the collapsed steps as a reason to escalate their turns.
 *
 * One node per session (metric by default), anchored to the session and to each
 * collapsed step's message. The node records the repeating motif, never the
 * looping text: reasoning is the model's private content and the graph is
 * durable and widely readable.
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
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { Type, type Static } from "typebox";
import {
	DEFAULT_REPETITION_COLLAPSE_CONFIG,
	type RepetitionCollapseConfig,
} from "./config.js";
import { CollapsedStepSchema, scanSteps, type CollapsedStep } from "./detect.js";

/** A proposal this analyzer embeds in its node; materialised by the framework. */
export const RepetitionCollapseRawProposal = Type.Object({
	target_type: Type.String(),
	target_path: Type.Optional(Type.String()),
	title: Type.String(),
	summary: Type.String(),
	detail: Type.String(),
	evidence: Type.String(),
	confidence: Type.Number(),
	severity: Type.String(),
});
export type RepetitionCollapseRawProposal = Static<typeof RepetitionCollapseRawProposal>;

/** The properties a repetition-collapse node carries in its `contentJson`. */
export const REPETITION_COLLAPSE_PROPERTIES = Type.Object({
	session_id: Type.String(),
	judged_step_count: Type.Number(),
	collapsed: Type.Array(CollapsedStepSchema),
	collapsed_step_count: Type.Number(),
	/** Collapsed steps that produced no answer and no tool call. */
	undelivered_step_count: Type.Number(),
	/** Billed dollars of the undelivered steps, or null when none of them was priced. */
	undelivered_cost_usd: Type.Union([Type.Number(), Type.Null()]),
	improvement_proposals: Type.Array(RepetitionCollapseRawProposal),
});
export type RepetitionCollapseProperties = Static<typeof REPETITION_COLLAPSE_PROPERTIES>;

export const REPETITION_COLLAPSE_DEF: AnalyzerDef = {
	id: "repetition-collapse",
	label: "Repetition Collapse (deterministic)",
	description:
		"Flags assistant steps whose reasoning or answer loops on a repeated phrase or sub-word motif — word n-gram and character-motif repetition ratios, no LLM. Proposes a routing change when a looping step delivered nothing.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: REPETITION_COLLAPSE_PROPERTIES,
};

export const REPETITION_COLLAPSE_VERSION: AnalyzerVersion = {
	analyzerId: REPETITION_COLLAPSE_DEF.id,
	// 1.0 (issue #278): per-step word and character repetition ratios over
	// reasoning and answer text, with a proposal gated on undelivered collapses.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/repetition-collapse/index.ts",
};

function resolveConfig(raw: unknown): RepetitionCollapseConfig {
	return (raw as RepetitionCollapseConfig) ?? DEFAULT_REPETITION_COLLAPSE_CONFIG;
}

/**
 * Fingerprint of everything a step's verdict reads: its texts, whether it
 * called a tool, and the model, cost, and stop reason recorded beside it. A
 * re-sync that backfills any of them re-identifies the unit as missing.
 */
function stepFingerprint(messages: readonly MessageRow[]): string {
	const lines: string[] = [];
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		const thinking = m.content_thinking ?? "";
		const text = m.content_text ?? "";
		lines.push(
			[m.id, thinking.length, shortHash(thinking), text.length, shortHash(text), m.tool_calls ? shortHash(m.tool_calls) : "", m.model ?? "", m.cost_usd ?? "", m.stop_reason ?? ""].join(":"),
		);
	}
	return shortHash(lines.join("\n"));
}

const EVIDENCE_EXAMPLE_CAP = 5;

function describeStep(s: CollapsedStep): string {
	const cost = s.cost_usd === null ? "unpriced" : `$${s.cost_usd.toFixed(2)}`;
	return (
		`turn#${s.pair_index} ${s.model ?? "unrecorded model"} ${s.channel} ${s.measure.chars} chars ` +
		`(word=${s.measure.word.toFixed(2)} char=${s.measure.char.toFixed(2)}, motif ${JSON.stringify(s.measure.motif)}), ` +
		`stop=${s.stop_reason ?? "unrecorded"}, ${cost}`
	);
}

export function buildProposal(
	properties: Omit<RepetitionCollapseProperties, "improvement_proposals">,
): RepetitionCollapseRawProposal {
	const undelivered = properties.collapsed.filter((s) => !s.delivered);
	const n = undelivered.length;
	const models = [...new Set(undelivered.map((s) => s.model ?? "unrecorded"))].sort();
	const cost = properties.undelivered_cost_usd === null ? "" : ` costing $${properties.undelivered_cost_usd.toFixed(2)}`;
	return {
		target_type: "config",
		title: `${n} step${n === 1 ? "" : "s"} looped on repeated text and delivered nothing`,
		summary:
			`${n} assistant step${n === 1 ? "" : "s"}${cost} repeated a phrase or fragment until the generation ended, returning no answer and no tool call (model${models.length === 1 ? "" : "s"}: ${models.join(", ")}). ` +
			"Each was billed in full, and the session continued as though the step were normal.",
		detail:
			"A model that collapses into repetition on a kind of turn is a routing signal: route these turns to a model that does not loop on them, or cap the reasoning budget and set a repetition penalty for this model so a collapse ends early instead of running to the limit. A step that ends in a loop with no answer should also be retried rather than accepted as a finished step.",
		evidence: `Looping steps (up to ${EVIDENCE_EXAMPLE_CAP}): ${undelivered.slice(0, EVIDENCE_EXAMPLE_CAP).map(describeStep).join("; ")}`,
		confidence: 0.7,
		severity: "waste",
	};
}

export const repetitionCollapseAnalyzer: Analyzer = {
	def: REPETITION_COLLAPSE_DEF,
	version: REPETITION_COLLAPSE_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: REPETITION_COLLAPSE_DEF.id,
		configHash: computeConfigHash(DEFAULT_REPETITION_COLLAPSE_CONFIG),
		configJson: DEFAULT_REPETITION_COLLAPSE_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		const config = resolveConfig(ctx.config);
		const pairs = await ctx.getTurnPairs(ctx.sessionId);
		// No step long enough to judge: there is no honest measurement to carry.
		if (scanSteps(pairs, ctx.messages, config).judged_step_count === 0) return [];

		const fingerprint = stepFingerprint(ctx.messages);
		const sources: SourceRef[] = [{ kind: "session", id: `${ctx.sessionId}#steps=${fingerprint}` }];
		return [
			{
				sources,
				sourceSetHash: shortHash(`repetition-collapse(${ctx.sessionId}|${fingerprint})`),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
			},
		];
	},

	async analyze(_unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		const pairs = await ctx.getTurnPairs(ctx.sessionId);
		const scan = scanSteps(pairs, messages, config);

		const undelivered = scan.collapsed.filter((s) => !s.delivered);
		const priced = undelivered.filter((s) => s.cost_usd !== null);
		const base: Omit<RepetitionCollapseProperties, "improvement_proposals"> = {
			session_id: ctx.sessionId,
			judged_step_count: scan.judged_step_count,
			collapsed: scan.collapsed,
			collapsed_step_count: scan.collapsed.length,
			undelivered_step_count: undelivered.length,
			undelivered_cost_usd: priced.length > 0 ? priced.reduce((sum, s) => sum + (s.cost_usd ?? 0), 0) : null,
		};

		const proposals: RepetitionCollapseRawProposal[] =
			undelivered.length >= config.minUndeliveredForProposal ? [buildProposal(base)] : [];
		const properties: RepetitionCollapseProperties = { ...base, improvement_proposals: proposals };

		// Anchor each collapsed step's own message, so the finding walks back to
		// the exact generation that looped.
		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
			...scan.collapsed.map((s, i) => ({
				toRefKind: REF_KINDS.MESSAGE,
				toRefId: s.message_id,
				edgeKind: EDGE_KINDS.ANCHORS,
				ordinal: i + 1,
			})),
		];

		return {
			nodeKind: proposals.length > 0 ? "proposal" : "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			edges,
		};
	},
};
