/**
 * decode-collapse — deterministic detection of assistant generations that
 * stopped being language (issue #277).
 *
 * A collapsed generation is corrupt from its first token to its last: real words
 * and code fragments in an order that means nothing, often leaking chat-template
 * control tokens, usually a large reasoning block followed by an empty answer.
 * The tokens are billed and no work comes back. Nothing else sees it: the text
 * is mostly Latin by letter count, so `language-mismatch` passes it; it never
 * repeats, so repetition detectors pass it; and position in the conversation
 * predicts nothing.
 *
 * What does see it is perplexity under a word n-gram model trained on this
 * corpus's own transcripts — a model trained on prose finds identifiers and
 * ticket ids as surprising as garbage, one trained on agent transcripts does
 * not. `reference.ts` holds the training and calibration discipline; this
 * module scores one session against it.
 *
 * One node per session with at least one document, anchored to the session and
 * to each flagged message. A session scored against a corpus too small to train
 * on records its collapse count as unknown (null), never as zero: a silent zero
 * would read as a clean session. The threshold is a ranking aid — the node
 * always carries the highest-scoring documents so a person can confirm the tail.
 */

import { Type, type Static } from "typebox";
import type {
	Analyzer,
	AnalyzerDef,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	AnalysisResult,
	AnalysisUnit,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeConfigHash, computeSourceSetHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { DEFAULT_DECODE_COLLAPSE_CONFIG, type DecodeCollapseConfig } from "./config.js";
import { DocumentField, documentsFingerprint, extractDocuments } from "./documents.js";
import { median } from "./ngram.js";
import { Calibration, ReferenceCorpus, ReferenceCoverage, getReference, round } from "./reference.js";

/** A proposal this analyzer embeds in its node; materialised by the framework. */
export const DecodeCollapseRawProposal = Type.Object({
	target_type: Type.String(),
	target_path: Type.Optional(Type.String()),
	title: Type.String(),
	summary: Type.String(),
	detail: Type.String(),
	evidence: Type.String(),
	confidence: Type.Number(),
	severity: Type.String(),
});
export type DecodeCollapseRawProposal = Static<typeof DecodeCollapseRawProposal>;

/** One scored document. No text: the anchored message is where a reader goes to look. */
export const ScoredDocument = Type.Object({
	message_id: Type.String(),
	field: DocumentField,
	model: Type.Union([Type.String(), Type.Null()]),
	token_count: Type.Number(),
	/** Median line perplexity, or null when the corpus was too small to train on. */
	perplexity: Type.Union([Type.Number(), Type.Null()]),
	/** Share of the document's shingles seen in another reference session. */
	cross_session_share: Type.Number(),
	answer_empty: Type.Boolean(),
	control_tokens: Type.Array(Type.String()),
	collapsed: Type.Boolean(),
});
export type ScoredDocument = Static<typeof ScoredDocument>;

export const DECODE_COLLAPSE_PROPERTIES = Type.Object({
	session_id: Type.String(),
	/** `ready` when the model and threshold stood behind the scores; otherwise nothing was judged. */
	model_status: Type.Union([Type.Literal("ready"), Type.Literal("insufficient_corpus")]),
	coverage: ReferenceCoverage,
	calibration: Type.Union([Calibration, Type.Null()]),
	document_count: Type.Number(),
	/** Null when the corpus could not support a verdict — unknown, not zero. */
	collapsed_count: Type.Union([Type.Number(), Type.Null()]),
	median_perplexity: Type.Union([Type.Number(), Type.Null()]),
	collapsed_documents: Type.Array(ScoredDocument),
	top_documents: Type.Array(ScoredDocument),
	improvement_proposals: Type.Array(DecodeCollapseRawProposal),
});
export type DecodeCollapseProperties = Static<typeof DECODE_COLLAPSE_PROPERTIES>;

export const DECODE_COLLAPSE_DEF: AnalyzerDef = {
	id: "decode-collapse",
	label: "Decode Collapse (deterministic)",
	description:
		"Flags assistant generations that stopped being language — corrupt from the first token, often leaking chat-template control tokens — by median line perplexity under a word n-gram model trained on this corpus's own sessions, filtered by cross-session shingle overlap and calibrated on held-out sessions. No LLM.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: DECODE_COLLAPSE_PROPERTIES,
};

export const DECODE_COLLAPSE_VERSION: AnalyzerVersion = {
	analyzerId: DECODE_COLLAPSE_DEF.id,
	// 1.0 (issue #277): in-process word n-gram model with interpolated absolute
	// discounting, trained on the earliest reference sessions after a
	// cross-session shingle filter, calibrated on held-out sessions, scoring
	// each session with its own counts subtracted.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/decode-collapse/index.ts",
};

function resolveConfig(raw: unknown): DecodeCollapseConfig {
	return (raw as DecodeCollapseConfig) ?? DEFAULT_DECODE_COLLAPSE_CONFIG;
}

/** Highest perplexity first; unscored documents last; ties in transcript order. */
function byScoreDescending(a: ScoredDocument, b: ScoredDocument): number {
	return (b.perplexity ?? -1) - (a.perplexity ?? -1);
}

export function buildProposal(collapsed: readonly ScoredDocument[], calibration: Calibration): DecodeCollapseRawProposal {
	const models = [...new Set(collapsed.map((d) => d.model ?? "unrecorded model"))].sort();
	const leaked = [...new Set(collapsed.flatMap((d) => d.control_tokens))].sort();
	const empty = collapsed.filter((d) => d.answer_empty).length;
	const n = collapsed.length;
	const worst = Math.max(...collapsed.map((d) => d.perplexity ?? 0));
	return {
		target_type: "config",
		target_path: models.join(", "),
		title: `${n} assistant generation${n === 1 ? "" : "s"} collapsed into non-language output`,
		summary:
			`${n} document${n === 1 ? "" : "s"} scored above every held-out session of this corpus (threshold ${calibration.threshold}, worst ${worst})` +
			(empty > 0 ? `, ${empty} of them from a generation that returned no answer` : "") +
			". Those tokens were billed and returned no work.",
		detail:
			"Output that is corrupt from its first token is a serving defect — a chat-template, tokenizer, or quantisation mismatch at the provider — not something a standing instruction can fix. Confirm the anchored turns first: the threshold is a ranking aid calibrated on held-out sessions, not a label. If they are collapsed, route this model to a different provider or model in config, and report it to the provider.",
		evidence:
			`models: ${models.join(", ")}; held-out median ${calibration.held_out_median}, max ${calibration.held_out_max} over ${calibration.held_out_documents} documents` +
			(leaked.length > 0 ? `; leaked control tokens: ${leaked.join(" ")}` : ""),
		confidence: 0.5,
		severity: "waste",
	};
}

export const decodeCollapseAnalyzer: Analyzer = {
	def: DECODE_COLLAPSE_DEF,
	version: DECODE_COLLAPSE_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: DECODE_COLLAPSE_DEF.id,
		configHash: computeConfigHash(DEFAULT_DECODE_COLLAPSE_CONFIG),
		configJson: DEFAULT_DECODE_COLLAPSE_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		const config = resolveConfig(ctx.config);
		const docs = extractDocuments(ctx.messages, config);
		if (docs.length === 0) return [];

		// The model and threshold are functions of the reference sessions, so
		// identity commits to each of them by content, beside this session's own.
		const reference = await getReference(ctx.db, config);
		const sources: SourceRef[] = [
			{ kind: "session", id: `${ctx.sessionId}#decode=${documentsFingerprint(docs)}` },
			...reference.sourceRefs,
		];
		return [
			{
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
				meta: { reference },
			},
		];
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const reference = unit.meta?.["reference"];
		if (!(reference instanceof ReferenceCorpus)) {
			throw new Error("decode-collapse: unit carries no reference corpus; analyze() must follow this analyzer's plan()");
		}
		const docs = extractDocuments(await ctx.getSessionMessages(ctx.sessionId), config);
		const scorer = reference.scorerFor(ctx.sessionId);
		const threshold = scorer.calibration?.threshold ?? null;

		const scored: ScoredDocument[] = docs.map((d) => {
			const raw = scorer.score(d.tokens);
			const perplexity = raw === null ? null : round(raw);
			return {
				message_id: d.message_id,
				field: d.field,
				model: d.model,
				token_count: d.token_count,
				perplexity,
				cross_session_share: Math.round(scorer.crossSessionShare(d.tokens) * 1000) / 1000,
				answer_empty: d.answer_empty,
				control_tokens: d.control_tokens,
				collapsed: perplexity !== null && threshold !== null && perplexity > threshold,
			};
		});

		const collapsed = scored.filter((d) => d.collapsed);
		const ranked = [...scored].sort(byScoreDescending);
		const perplexities = scored.flatMap((d) => (d.perplexity === null ? [] : [d.perplexity]));
		const proposals =
			scorer.calibration && collapsed.length >= config.minCollapsesForProposal
				? [buildProposal(collapsed, scorer.calibration)]
				: [];

		const properties: DecodeCollapseProperties = {
			session_id: ctx.sessionId,
			model_status: scorer.ready ? "ready" : "insufficient_corpus",
			coverage: scorer.coverage,
			calibration: scorer.calibration,
			document_count: scored.length,
			collapsed_count: scorer.ready ? collapsed.length : null,
			median_perplexity: perplexities.length > 0 ? round(median(perplexities)) : null,
			collapsed_documents: collapsed,
			top_documents: scorer.ready ? ranked.slice(0, config.topDocuments) : [],
			improvement_proposals: proposals,
		};

		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
		];
		let ordinal = 1;
		for (const id of new Set(collapsed.map((d) => d.message_id))) {
			edges.push({ toRefKind: REF_KINDS.MESSAGE, toRefId: id, edgeKind: EDGE_KINDS.ANCHORS, ordinal: ordinal++ });
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
