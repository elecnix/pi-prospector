/**
 * language-mismatch — deterministic detection of language disagreement between
 * the user, the agent, and the harness (issue #151).
 *
 * A response written in a different language than the question loses the user:
 * they chose their words in a language they read comfortably, and the answer
 * arrives in one they may have to translate. The same loss happens one level
 * down: a compaction summary (the normalized `compactionSummary` role from
 * #150) written in a different language than the conversation it compresses
 * replaces the user's own context with something they did not ask for — and
 * signals a harness misconfiguration rather than an agent choice.
 *
 * Both axes are deterministic script comparisons over the shared turn-pair
 * construction (`detect.ts`): a Unicode-block heuristic counts each text's
 * letters per script after code blocks / inline code / URLs are stripped, and
 * two texts are flagged only when both are judgable and their scripts differ
 * materially. Same-script differences (French question, English reply) are
 * honestly out of reach for a dependency-light heuristic and are never guessed
 * at; the learned frustration lexicon remains the language-aware layer.
 *
 * One node per session (metric by default), anchored to the session with
 * additional anchors edges onto each judged turn's user message and each
 * checked compaction entry. When mismatches recur above the config threshold
 * the node carries one improvement proposal — a standing instruction to respond
 * in the user's language, and to keep compaction summaries in the
 * conversation's language — following the failure-modes / uncompleted-leads /
 * compression-checklist convention for recurrence-gated deterministic
 * proposals.
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
	DEFAULT_LANGUAGE_MISMATCH_CONFIG,
	type LanguageMismatchConfig,
} from "./config.js";
import {
	CompactionVerdictSchema,
	scanSession,
	TurnVerdictSchema,
} from "./detect.js";

/** A proposal this analyzer embeds in its node; materialised by the framework. */
export const LanguageMismatchRawProposal = Type.Object({
	target_type: Type.String(),
	target_path: Type.Optional(Type.String()),
	title: Type.String(),
	summary: Type.String(),
	detail: Type.String(),
	evidence: Type.String(),
	confidence: Type.Number(),
	severity: Type.String(),
});
export type LanguageMismatchRawProposal = Static<typeof LanguageMismatchRawProposal>;

/** The properties a language-mismatch node carries in its `contentJson`. */
export const LANGUAGE_MISMATCH_PROPERTIES = Type.Object({
	session_id: Type.String(),
	turns: Type.Array(TurnVerdictSchema),
	compactions: Type.Array(CompactionVerdictSchema),
	judged_turn_count: Type.Number(),
	mismatched_turn_count: Type.Number(),
	compaction_checked_count: Type.Number(),
	mismatched_compaction_count: Type.Number(),
	improvement_proposals: Type.Array(LanguageMismatchRawProposal),
});
export type LanguageMismatchProperties = Static<typeof LANGUAGE_MISMATCH_PROPERTIES>;

export const LANGUAGE_MISMATCH_DEF: AnalyzerDef = {
	id: "language-mismatch",
	label: "Language Mismatch (deterministic)",
	description:
		"Flags turn pairs whose assistant response is written in a different script than the user's message, and compaction summaries written in a different script than the conversation they compress — via a Unicode-block heuristic, no LLM and no new dependencies. Proposes once the pattern recurs.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: LANGUAGE_MISMATCH_PROPERTIES,
};

export const LANGUAGE_MISMATCH_VERSION: AnalyzerVersion = {
	analyzerId: LANGUAGE_MISMATCH_DEF.id,
	// 1.0 (issue #151): per-turn script comparison over the shared turn-pair
	// construction plus compaction-summary checks against preceding user text,
	// with a recurrence-gated proposal across both axes.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/language-mismatch/index.ts",
};

function resolveConfig(raw: unknown): LanguageMismatchConfig {
	return (raw as LanguageMismatchConfig) ?? DEFAULT_LANGUAGE_MISMATCH_CONFIG;
}

/**
 * Fingerprint of everything this analyzer reads: every user, assistant, and
 * compaction-summary text. Hashing the texts themselves (not just which rows
 * exist) makes a re-sync that backfills content re-identify as missing and
 * recompute — the same trade compression-checklist makes for its result texts.
 */
function languageFingerprint(messages: readonly MessageRow[]): string {
	const lines: string[] = [];
	for (const m of messages) {
		if (m.role !== "user" && m.role !== "assistant" && m.role !== "compactionSummary") continue;
		const text = m.content_text ?? "";
		lines.push(`${m.role}:${m.id}:${text.length}:${shortHash(text)}`);
	}
	return shortHash(lines.join("\n"));
}

const EVIDENCE_EXAMPLE_CAP = 5;

function describeMismatch(prefix: string, from: string, to: string): string {
	return `${prefix}: ${from} → ${to}`;
}

export function buildProposal(
	properties: Omit<LanguageMismatchProperties, "improvement_proposals">,
): LanguageMismatchRawProposal {
	const examples: string[] = [];
	for (const t of properties.turns.filter((t) => t.mismatched)) {
		if (examples.length >= EVIDENCE_EXAMPLE_CAP) break;
		examples.push(describeMismatch(`turn#${t.pair_index}`, t.user_script, t.assistant_script));
	}
	for (const c of properties.compactions.filter((c) => c.mismatched)) {
		if (examples.length >= EVIDENCE_EXAMPLE_CAP) break;
		examples.push(describeMismatch("compaction", c.conversation_script, c.summary_script));
	}
	const total = properties.mismatched_turn_count + properties.mismatched_compaction_count;
	return {
		target_type: "agents_md",
		title: `Agent or harness answered in the wrong language ${total} time${total === 1 ? "" : "s"}`,
		summary:
			`${properties.mismatched_turn_count} turn(s) were answered in a different script than the user's message` +
			(properties.compaction_checked_count > 0
				? `, and ${properties.mismatched_compaction_count} of ${properties.compaction_checked_count} compaction summaries switched language on the conversation they compressed`
				: "") +
			". A reader who writes in one language should not have to translate the answers.",
		detail:
			"Add a standing instruction that responses stay in the language of the user's most recent message, and that compaction/context summaries keep the conversation's language — a summary that switches language silently replaces the user's own context and usually means the summarisation prompt is misconfigured.",
		evidence: `Mismatched scripts (up to ${EVIDENCE_EXAMPLE_CAP}): ${examples.join("; ")}`,
		confidence: 0.6,
		severity: "friction",
	};
}

export const languageMismatchAnalyzer: Analyzer = {
	def: LANGUAGE_MISMATCH_DEF,
	version: LANGUAGE_MISMATCH_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: LANGUAGE_MISMATCH_DEF.id,
		configHash: computeConfigHash(DEFAULT_LANGUAGE_MISMATCH_CONFIG),
		configJson: DEFAULT_LANGUAGE_MISMATCH_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		const config = resolveConfig(ctx.config);
		const pairs = await ctx.getTurnPairs(ctx.sessionId);
		const scan = scanSession(pairs, ctx.messages, config);
		// Nothing judgable anywhere — every text too short or mixed-script — so
		// there is no honest measurement this session could carry.
		if (scan.turns.length === 0 && scan.compactions.length === 0) return [];

		const fingerprint = languageFingerprint(ctx.messages);
		const sources: SourceRef[] = [
			{ kind: "session", id: `${ctx.sessionId}#lang=${fingerprint}` },
		];
		return [
			{
				sources,
				sourceSetHash: shortHash(`language-mismatch(${ctx.sessionId}|${fingerprint})`),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
			},
		];
	},

	async analyze(_unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		const pairs = await ctx.getTurnPairs(ctx.sessionId);
		const scan = scanSession(pairs, messages, config);

		const mismatchedTurnCount = scan.turns.filter((t) => t.mismatched).length;
		const mismatchedCompactionCount = scan.compactions.filter((c) => c.mismatched).length;

		const base: Omit<LanguageMismatchProperties, "improvement_proposals"> = {
			session_id: ctx.sessionId,
			turns: scan.turns,
			compactions: scan.compactions,
			judged_turn_count: scan.turns.length,
			mismatched_turn_count: mismatchedTurnCount,
			compaction_checked_count: scan.compactions.length,
			mismatched_compaction_count: mismatchedCompactionCount,
		};

		const total = mismatchedTurnCount + mismatchedCompactionCount;
		const proposals: LanguageMismatchRawProposal[] =
			total >= config.minMismatchesForProposal ? [buildProposal(base)] : [];

		const properties: LanguageMismatchProperties = { ...base, improvement_proposals: proposals };

		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
		];
		// Anchor each judged turn's user message and each checked compaction
		// entry, so the finding walks back to the exact words that disagreed.
		let ordinal = 1;
		const anchored = new Set<string>();
		for (const t of scan.turns) {
			if (anchored.has(t.user_message_id)) continue;
			anchored.add(t.user_message_id);
			edges.push({ toRefKind: REF_KINDS.MESSAGE, toRefId: t.user_message_id, edgeKind: EDGE_KINDS.ANCHORS, ordinal: ordinal++ });
		}
		for (const c of scan.compactions) {
			if (anchored.has(c.message_id)) continue;
			anchored.add(c.message_id);
			edges.push({ toRefKind: REF_KINDS.MESSAGE, toRefId: c.message_id, edgeKind: EDGE_KINDS.ANCHORS, ordinal: ordinal++ });
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
