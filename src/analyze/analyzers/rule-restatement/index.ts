/**
 * rule-restatement — is a proposed rule already a rule? (issue #265)
 *
 * A rule-shaped proposal asks to add a line to a standing instruction. Most
 * high-confidence ones sampled in the wild proposed a rule the agent already
 * had: the friction was real, but it was an **adherence** problem (a rule that
 * exists and was not followed), not a **gap** (a rule that does not exist). The
 * proposal text renders the two identically, and acting on a restatement adds a
 * duplicate line to a context-budgeted file, costs every future session, and
 * changes nothing.
 *
 * For every open rule-shaped proposal, this analyzer reads the session's
 * instruction corpus (see corpus.ts) and asks a model whether the rule is there,
 * possibly in other words or stated from its other end. A claim that it is must
 * quote the existing rule, and the quote is checked against the corpus before
 * it is believed. The verdict is a content-addressed `restatement` node that
 * `consumes` the proposal's summary node; the framework writes the resulting
 * rule status back onto the proposal.
 *
 * Replay validation cannot answer this question: its baseline replays the turn
 * text alone, without the instructions in force, so a restated rule "averts"
 * friction just as well as a new one.
 *
 * A session with no instruction corpus plans nothing: its proposals stay
 * `unchecked`, which is what they are.
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
import { computeConfigHash, computeSourceSetHash, shortHash } from "../../input-hash.js";
import { resolveModelSpec } from "../../model-tiers.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { SESSION_OVERVIEW_DEF } from "../session-overview/index.js";
import { getSessionScope, listOpenProposalsForSession } from "../../../db/queries.js";
import { DEFAULT_RULE_RESTATEMENT_CONFIG, type RuleRestatementConfig } from "./config.js";
import {
	InstructionFile,
	InstructionScope,
	instructionCandidateGroups,
	instructionHome,
	readInstructionCorpus,
	selectCorpus,
} from "./corpus.js";
import {
	JUDGE_RESTATEMENT_PROMPT,
	JUDGE_RESTATEMENT_PROMPT_HASH,
	JUDGE_RESTATEMENT_TOOL,
	RestatementVerdict,
	RuleProposal,
	buildRestatementPrompt,
	extractJudgement,
	locateQuote,
	proposalText,
} from "./prompt.js";

/**
 * What the proposal's rule is, relative to the corpus:
 *   unchecked  — never judged (no corpus, or not rule-shaped); the default
 *   gap        — the corpus does not state it
 *   partial    — the corpus states part or a weaker form of it
 *   restated   — the corpus already states it: an adherence finding
 *   ungrounded — the model said it exists but its quote is not in the corpus
 */
export const RuleStatus = Type.Union([
	Type.Literal("unchecked"),
	Type.Literal("gap"),
	Type.Literal("partial"),
	Type.Literal("restated"),
	Type.Literal("ungrounded"),
]);
export type RuleStatus = Static<typeof RuleStatus>;

/** Longest existing-rule quote kept on the node and the proposal. */
const MAX_QUOTE_CHARS = 500;

export const RuleRestatementContent = Type.Object({
	/** The judged proposal, by its content-addressed input_key. */
	proposal_input_key: Type.String(),
	model: Type.String(),
	/** What the model answered, before its quote was checked. */
	model_verdict: RestatementVerdict,
	/** The verdict after grounding — what is written back onto the proposal. */
	rule_status: RuleStatus,
	/** The file the quote was found in; null for a gap or an ungrounded claim. */
	rule_path: Type.Union([Type.String(), Type.Null()]),
	/** The existing rule as quoted; null for a gap. */
	rule_quote: Type.Union([Type.String(), Type.Null()]),
	rationale: Type.String(),
	/** Every file that was in scope, by content hash — the corpus this verdict is about. */
	corpus: Type.Array(
		Type.Object({ path: Type.String(), scope: InstructionScope, content_hash: Type.String(), chars: Type.Number() }),
	),
	/** Whether the corpus exceeded the budget and only its most relevant passages were read. */
	corpus_excerpted: Type.Boolean(),
});
export type RuleRestatementContent = Static<typeof RuleRestatementContent>;

export const RULE_RESTATEMENT_DEF: AnalyzerDef = {
	id: "rule-restatement",
	label: "Rule Restatement Check",
	description:
		"For each open rule-shaped proposal (agents_md/skill/prompt), reads the instruction files the session's harness loads — its global file and the project files on the cwd path — plus any configured paths, and asks a model whether the rule is already stated there, in any wording. A claim that it is must quote the existing rule verbatim. Writes the rule status (gap/partial/restated) back onto the proposal, separating adherence findings from gaps. Consumes session-overview summaries.",
	anchorSpan: "full_session",
	dependencies: [SESSION_OVERVIEW_DEF.id],
	outputSchema: RuleRestatementContent,
};

export const RULE_RESTATEMENT_VERSION: AnalyzerVersion = {
	analyzerId: RULE_RESTATEMENT_DEF.id,
	major: 1,
	minor: 0,
	implementationKind: "in_process_llm",
	codeRef: "src/analyze/analyzers/rule-restatement/index.ts",
};

const PROMPTS: Record<string, PromptVersion> = {
	judge_restatement: { hash: JUDGE_RESTATEMENT_PROMPT_HASH, content: JUDGE_RESTATEMENT_PROMPT, role: "judge" },
};

const RestatementMeta = Type.Object({
	proposalInputKey: Type.String(),
	proposal: RuleProposal,
	files: Type.Array(InstructionFile),
	/** The consumed summary node's output_key, or "" when it is absent. */
	summaryOutputKey: Type.String(),
});
type RestatementMeta = Static<typeof RestatementMeta>;

function configOf(raw: unknown): RuleRestatementConfig {
	return { ...DEFAULT_RULE_RESTATEMENT_CONFIG, ...((raw as Partial<RuleRestatementConfig> | undefined) ?? {}) };
}

export const ruleRestatementAnalyzer: Analyzer = {
	def: RULE_RESTATEMENT_DEF,
	version: RULE_RESTATEMENT_VERSION,
	prompts: PROMPTS,
	defaultConfig: {
		id: "",
		analyzerId: RULE_RESTATEMENT_DEF.id,
		configHash: computeConfigHash(DEFAULT_RULE_RESTATEMENT_CONFIG),
		configJson: DEFAULT_RULE_RESTATEMENT_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	modelsForIdentity(config, modelTiers): string[] {
		return [resolveModelSpec(configOf(config).tier, modelTiers)];
	},

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		const config = configOf(ctx.config);
		const targetTypes = new Set(config.targetTypes);
		const proposals = (await listOpenProposalsForSession(ctx.db, ctx.sessionId)).filter((p) => targetTypes.has(p.target_type));
		if (proposals.length === 0) return [];

		const scope = await getSessionScope(ctx.db, ctx.sessionId);
		const files = readInstructionCorpus(
			instructionCandidateGroups({ source: scope?.source ?? "", cwd: scope?.cwd ?? "", home: instructionHome(), config }),
		);
		if (files.length === 0) return [];

		const corpusSources: SourceRef[] = files.map((f) => ({ kind: "instruction" as const, id: `${f.path}#${f.contentHash}` }));
		const nodeById = new Map(ctx.allNodes.map((n) => [n.id, n]));

		return proposals.map((p) => {
			const summaryOutputKey = (p.source_node_id ? nodeById.get(p.source_node_id)?.output_key : undefined) ?? "";
			const meta: RestatementMeta = {
				proposalInputKey: p.input_key,
				proposal: {
					title: p.title,
					summary: p.summary,
					detail: p.detail,
					target_type: p.target_type,
					target_path: p.target_path,
				},
				files,
				summaryOutputKey,
			};
			// Identity: the proposal (its input_key already folds in the summary's
			// output_key) and every instruction file by content. Editing any file in
			// scope re-identifies the check, so the next scan finds it missing.
			const sources: SourceRef[] = summaryOutputKey
				? [{ kind: "analysis_node", id: summaryOutputKey }, ...corpusSources]
				: corpusSources;
			return {
				sources,
				sourceSetHash: shortHash(`rule-restatement(${p.input_key}|${computeSourceSetHash(corpusSources)})`),
				anchorKind: "session" as const,
				anchorRef: ctx.sessionId,
				meta: meta as unknown as Record<string, unknown>,
			};
		});
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = configOf(ctx.config.configJson);
		const meta = unit.meta as unknown as RestatementMeta;
		const model = resolveModelSpec(config.tier, ctx.modelTiers);
		const corpus = selectCorpus(meta.files, proposalText(meta.proposal), config.maxCorpusChars);

		const response = await ctx.llm({
			model,
			system: ctx.prompts["judge_restatement"] ?? JUDGE_RESTATEMENT_PROMPT,
			user: buildRestatementPrompt(meta.proposal, corpus),
			temperature: config.temperature,
			maxTokens: 600,
			tool: JUDGE_RESTATEMENT_TOOL,
		});

		// A guessed verdict is worse than none: "gap" invites a duplicate rule and
		// "restated" hides a real one. Failing records an error node and leaves the
		// unit missing, so the next run retries it.
		const judgement = extractJudgement(response.structured, response.text);
		if (!judgement) {
			throw new Error(
				`Model '${response.model}' returned no usable judge_restatement verdict for proposal ${meta.proposalInputKey}. ` +
					`Use a model that supports forced tool calls.`,
			);
		}

		const content = groundJudgement({
			proposalInputKey: meta.proposalInputKey,
			model,
			judgement,
			files: meta.files,
			excerpted: corpus.some((c) => c.excerpted),
		});

		const edges: AnalysisResult["edges"] = [];
		let ordinal = 0;
		if (meta.summaryOutputKey) {
			edges.push({ toRefKind: REF_KINDS.ANALYSIS_NODE, toRefId: meta.summaryOutputKey, edgeKind: EDGE_KINDS.CONSUMES, ordinal: ordinal++ });
		}
		edges.push({ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: ordinal++ });
		edges.push({ toRefKind: REF_KINDS.PROMPT_VERSION, toRefId: JUDGE_RESTATEMENT_PROMPT_HASH, edgeKind: EDGE_KINDS.USES_PROMPT, ordinal: ordinal++ });

		return {
			nodeKind: "restatement",
			contentJson: content as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			modelUsed: model,
			costUsd: response.costUsd,
			tokensUsed: response.tokensUsed,
			inputTokens: response.inputTokens,
			cachedInputTokens: response.cachedInputTokens,
			outputTokens: response.outputTokens,
			edges,
		};
	},
};

/**
 * Turn the model's answer into the node's content. A "restated"/"partial" claim
 * stands only if its quote is found in the corpus; otherwise it is recorded as
 * `ungrounded` — neither a gap (nobody showed the rule is absent) nor a
 * restatement (nobody showed it is present).
 */
export function groundJudgement(params: {
	proposalInputKey: string;
	model: string;
	judgement: { verdict: RestatementVerdict; path: string; quote: string; rationale: string };
	files: ReadonlyArray<{ path: string; scope: InstructionScope; content: string; contentHash: string }>;
	excerpted: boolean;
}): RuleRestatementContent {
	const { judgement, files } = params;
	let ruleStatus: RuleStatus;
	let rulePath: string | null = null;
	let ruleQuote: string | null = null;
	if (judgement.verdict === "gap") {
		ruleStatus = "gap";
	} else {
		ruleQuote = judgement.quote.trim().slice(0, MAX_QUOTE_CHARS) || null;
		rulePath = locateQuote(judgement.quote, files, judgement.path);
		ruleStatus = rulePath ? judgement.verdict : "ungrounded";
	}
	return {
		proposal_input_key: params.proposalInputKey,
		model: params.model,
		model_verdict: judgement.verdict,
		rule_status: ruleStatus,
		rule_path: rulePath,
		rule_quote: ruleQuote,
		rationale: judgement.rationale,
		corpus: files.map((f) => ({ path: f.path, scope: f.scope, content_hash: f.contentHash, chars: f.content.length })),
		corpus_excerpted: params.excerpted,
	};
}
