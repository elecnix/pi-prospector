/**
 * proposal-validate — offline replay validation of materialised proposals (issue #6).
 *
 * For each open proposal, this analyzer replays the candidate rule against the
 * originating high-signal turns the proposal carries (`source_message_ids`,
 * attached by session-overview). For every replay turn it asks a *distinct*
 * validator model to classify the turn twice — once as-is (baseline) and once
 * with the candidate rule injected as a standing instruction — and checks
 * whether the rule turns friction into no-friction.
 *
 * The result is a content-addressed `validation` node that `consumes` the
 * proposal's source summary node and `anchors` to the replayed turns. The
 * framework writes the grounded `validated_score` / `validation_status` back
 * onto the proposal (see proposal-materializer.applyValidationFromNode), so the
 * fast proposals table can rank by an *empirical* score instead of the model's
 * self-rated confidence — which the dogfood run showed was anti-correlated with
 * correctness.
 *
 * Caveats (see DESIGN.md): the validator inherits the classifier's blind spots
 * (text-only, no tool calls). The score is therefore labelled "replay-validated"
 * and stays advisory — it never edits anything.
 */

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
import { buildTurnPairs } from "../turn-pair-core/build.js";
import {
	CLASSIFY_PROMPT,
	CLASSIFY_PROMPT_HASH,
	CLASSIFY_TOOL,
	parseClassifyResponse,
	parseClassifyObject,
} from "../turn-pair-llm/prompt.js";
import { SESSION_OVERVIEW_DEF } from "../session-overview/index.js";
import { listOpenProposalsForSession } from "../../../db/queries.js";
import { buildBaselinePrompt, buildWithRulePrompt, composeRuleText } from "./prompt.js";
import { DEFAULT_PROPOSAL_VALIDATE_CONFIG, type ProposalValidateConfig } from "./config.js";

export const PROPOSAL_VALIDATE_DEF: AnalyzerDef = {
	id: "proposal-validate",
	label: "Proposal Replay Validation",
	description:
		"Opt-in, advisory: replays each open proposal against its originating turns with a distinct validator model, scoring whether injecting the rule averts the friction, and writes a grounded validated_score/status back onto the proposal. Consumes session-overview summaries.",
	anchorSpan: "full_session",
	dependencies: [SESSION_OVERVIEW_DEF.id],
};

export const PROPOSAL_VALIDATE_VERSION: AnalyzerVersion = {
	analyzerId: PROPOSAL_VALIDATE_DEF.id,
	major: 1,
	minor: 1,
	implementationKind: "in_process_llm",
	codeRef: "src/analyze/analyzers/proposal-validate/index.ts",
};

const PROMPTS: Record<string, PromptVersion> = {
	classify: { hash: CLASSIFY_PROMPT_HASH, content: CLASSIFY_PROMPT, role: "classify" },
};

/** A replayed turn's before/after classification. */
export interface ReplayTurnResult {
	message_id: string;
	baseline_friction: string;
	with_rule_friction: string;
	averted: boolean;
}

/** The content stored on a `validation` node. */
export interface ValidationContent {
	proposal_input_key: string;
	validator_model: string;
	replay_turns: ReplayTurnResult[];
	replay_turn_count: number;
	baseline_friction_turns: number;
	averted_turns: number;
	validated_score: number | null;
	validation_status: "supported" | "unsupported" | "unvalidated";
}

interface ValidateMeta {
	proposalInputKey: string;
	ruleText: string;
	replayMessageIds: string[];
	/** The consumed summary node's content-addressed output_key (the `consumes` edge target). */
	summaryOutputKey: string;
}

function parseMessageIds(json: string | null): string[] {
	if (!json) return [];
	try {
		const arr = JSON.parse(json) as unknown;
		return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

export const proposalValidateAnalyzer: Analyzer = {
	def: PROPOSAL_VALIDATE_DEF,
	version: PROPOSAL_VALIDATE_VERSION,
	prompts: PROMPTS,
	defaultConfig: {
		id: "",
		analyzerId: PROPOSAL_VALIDATE_DEF.id,
		configHash: computeConfigHash(DEFAULT_PROPOSAL_VALIDATE_CONFIG),
		configJson: DEFAULT_PROPOSAL_VALIDATE_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	modelsForIdentity(config, modelTiers): string[] {
		const cfg = (config as unknown as ProposalValidateConfig) ?? DEFAULT_PROPOSAL_VALIDATE_CONFIG;
		return [resolveModelSpec(cfg.validatorTier, modelTiers)];
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		const config = (ctx.config as unknown as ProposalValidateConfig) ?? DEFAULT_PROPOSAL_VALIDATE_CONFIG;
		const cap = Number.isFinite(config.maxReplayTurns) && config.maxReplayTurns >= 0 ? config.maxReplayTurns : undefined;

		const proposals = listOpenProposalsForSession(ctx.db, ctx.sessionId);

		const nodeById = new Map(ctx.allNodes.map((n) => [n.id, n]));
		const units: AnalysisUnit[] = [];

		for (const p of proposals) {
			const allReplayIds = parseMessageIds(p.source_message_ids);
			const replayMessageIds = cap === undefined ? allReplayIds : allReplayIds.slice(0, cap);
			const summaryNode = p.source_node_id ? nodeById.get(p.source_node_id) : undefined;
			// For the source-set *hash* keep the historical uuid fallback so identity is
			// stable even if the summary node is absent; the `consumes` *edge* uses only a
			// real content-addressed output_key (below), never a uuid.
			const summaryOutputKey = summaryNode?.output_key ?? (p.source_node_id ?? "");

			// Identity: the proposal (by its content-addressed input_key) + the exact
			// replay turns. Folding the proposal input_key in keeps each proposal's
			// validation unit distinct even when two proposals share the same originating
			// turns, while excluding mutable write-back columns such as validated_score,
			// validation_status, and validation_node_id.
			const replaySources: SourceRef[] = replayMessageIds.map((id) => ({ kind: "message" as const, id }));
			const idSources: SourceRef[] = summaryOutputKey
				? [{ kind: "analysis_node", id: summaryOutputKey }, ...replaySources]
				: replaySources;
			const sourceSetHash = shortHash(`proposal-validate(${p.input_key}|${computeSourceSetHash(replaySources)})`);

			const meta: ValidateMeta = {
				proposalInputKey: p.input_key,
				ruleText: composeRuleText(p),
				replayMessageIds,
				summaryOutputKey: summaryNode?.output_key ?? "",
			};

			units.push({
				sources: idSources,
				sourceSetHash,
				anchorKind: "session",
				anchorRef: ctx.sessionId,
				meta: meta as unknown as Record<string, unknown>,
			});
		}

		return units;
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = (ctx.config.configJson as unknown as ProposalValidateConfig) ?? DEFAULT_PROPOSAL_VALIDATE_CONFIG;
		const meta = unit.meta as unknown as ValidateMeta;
		const validatorModel = resolveModelSpec(config.validatorTier, ctx.modelTiers);

		const pairs = buildTurnPairs(ctx.getSessionMessages(ctx.sessionId));
		const pairByUser = new Map(pairs.map((p) => [p.userMessageId, p]));

		const replayTurns: ReplayTurnResult[] = [];
		let costUsd = 0;
		let tokensUsed = 0;

		for (const messageId of meta.replayMessageIds) {
			const pair = pairByUser.get(messageId);
			if (!pair) continue;

			const baselineRes = await ctx.llm({
				model: validatorModel,
				system: ctx.prompts["classify"] ?? CLASSIFY_PROMPT,
				user: buildBaselinePrompt({ userText: pair.userText, assistantText: pair.assistantText }),
				temperature: config.temperature,
				maxTokens: 500,
				tool: CLASSIFY_TOOL,
			});
			costUsd += baselineRes.costUsd;
			tokensUsed += baselineRes.tokensUsed;

			const withRuleRes = await ctx.llm({
				model: validatorModel,
				system: ctx.prompts["classify"] ?? CLASSIFY_PROMPT,
				user: buildWithRulePrompt({ userText: pair.userText, assistantText: pair.assistantText, rule: meta.ruleText }),
				temperature: config.temperature,
				maxTokens: 500,
				tool: CLASSIFY_TOOL,
			});
			costUsd += withRuleRes.costUsd;
			tokensUsed += withRuleRes.tokensUsed;

			const baseline = baselineRes.structured
				? parseClassifyObject(baselineRes.structured as Record<string, unknown>)
				: parseClassifyResponse(baselineRes.text);
			const withRule = withRuleRes.structured
				? parseClassifyObject(withRuleRes.structured as Record<string, unknown>)
				: parseClassifyResponse(withRuleRes.text);
			const baselineFriction = baseline.friction_type !== "none";
			const withRuleFriction = withRule.friction_type !== "none";

			replayTurns.push({
				message_id: messageId,
				baseline_friction: baseline.friction_type,
				with_rule_friction: withRule.friction_type,
				averted: baselineFriction && !withRuleFriction,
			});
		}

		const content = scoreReplay(meta.proposalInputKey, validatorModel, replayTurns, config.supportThreshold);

		const edges: AnalysisResult["edges"] = [];
		let ordinal = 0;
		if (meta.summaryOutputKey) {
			edges.push({
				toRefKind: REF_KINDS.ANALYSIS_NODE,
				toRefId: meta.summaryOutputKey,
				edgeKind: EDGE_KINDS.CONSUMES,
				ordinal: ordinal++,
			});
		}
		for (const t of replayTurns) {
			edges.push({ toRefKind: REF_KINDS.MESSAGE, toRefId: t.message_id, edgeKind: EDGE_KINDS.ANCHORS, ordinal: ordinal++ });
		}
		edges.push({ toRefKind: REF_KINDS.PROMPT_VERSION, toRefId: CLASSIFY_PROMPT_HASH, edgeKind: EDGE_KINDS.USES_PROMPT, ordinal: ordinal++ });

		return {
			nodeKind: "validation",
			contentJson: content as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			modelUsed: validatorModel,
			costUsd,
			tokensUsed,
			edges,
		};
	},
};

/**
 * Derive the grounded score and status from the per-turn replay results.
 *   - no replay turns at all            → unvalidated (score null)
 *   - no baseline friction reproduced   → unsupported (score 0): the validator
 *     could not even reproduce the friction the proposal claims to fix
 *   - otherwise score = averted / baseline-friction turns; supported iff
 *     score ≥ threshold.
 */
export function scoreReplay(
	proposalInputKey: string,
	validatorModel: string,
	replayTurns: ReplayTurnResult[],
	supportThreshold: number,
): ValidationContent {
	const baselineFrictionTurns = replayTurns.filter((t) => t.baseline_friction !== "none").length;
	const avertedTurns = replayTurns.filter((t) => t.averted).length;

	let validatedScore: number | null;
	let status: ValidationContent["validation_status"];
	if (replayTurns.length === 0) {
		validatedScore = null;
		status = "unvalidated";
	} else if (baselineFrictionTurns === 0) {
		validatedScore = 0;
		status = "unsupported";
	} else {
		validatedScore = avertedTurns / baselineFrictionTurns;
		status = validatedScore >= supportThreshold ? "supported" : "unsupported";
	}

	return {
		proposal_input_key: proposalInputKey,
		validator_model: validatorModel,
		replay_turns: replayTurns,
		replay_turn_count: replayTurns.length,
		baseline_friction_turns: baselineFrictionTurns,
		averted_turns: avertedTurns,
		validated_score: validatedScore,
		validation_status: status,
	};
}
