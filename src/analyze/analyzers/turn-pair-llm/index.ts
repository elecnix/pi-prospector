/**
 * turn-pair-llm — cheap LLM enrichment of high-signal turn pairs.
 *
 * Depends on turn-pair-core. Only pairs that the deterministic pass flagged as
 * `high_signal` are sent to the model, keeping cost bounded. Produces one
 * `classification` node per enriched pair, consuming the core metric node.
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
import { computeSourceSetHash, computeConfigHash } from "../../input-hash.js";
import { resolveModelSpec } from "../../model-tiers.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import {
	type PairToolCall,
	type PairToolResult,
} from "../turn-pair-core/build.js";
import { TURN_PAIR_CORE_DEF, type TurnPairCoreProperties } from "../turn-pair-core/index.js";
import { TURN_FRUSTRATION_DEF, type TurnFrustrationProperties } from "../turn-frustration/index.js";
import { TOOL_TRAJECTORY_DEF, type ToolTrajectoryProperties } from "../tool-trajectory/index.js";
import {
	EVIDENCE_SLICE_CEILING,
	buildMessageIdToPairIndex,
	collectTriggerPairIndexes,
	sliceStartIndex,
} from "../../evidence-slices.js";
import {
	CLASSIFY_PROMPT,
	CLASSIFY_PROMPT_HASH,
	CLASSIFY_TOOL,
	buildClassifyPrompt,
	parseClassifyResponse,
	parseClassifyObject,
	TurnPairLLMProperties,
	type SliceTurn,
	type ToolCallEvidence,
	type ToolResultEvidence,
} from "./prompt.js";
import { computeEnrichCap, DEFAULT_TURN_PAIR_LLM_CONFIG, type TurnPairLLMConfig } from "./config.js";
import { getMutedNodeIds } from "../../../db/assertions.js";

export const TURN_PAIR_LLM_DEF: AnalyzerDef = {
	id: "turn-pair-llm",
	label: "Per-Turn Classification (LLM)",
	description:
		"Classifies sentiment and friction type for high-signal turn pairs with a cheap model, given the user/assistant text plus the turn's actual tool calls and error heads so attribution lands on the command at fault.",
	anchorSpan: "pair",
	dependencies: [TURN_PAIR_CORE_DEF.id, TURN_FRUSTRATION_DEF.id, TOOL_TRAJECTORY_DEF.id],
	outputSchema: TurnPairLLMProperties,
};

export const TURN_PAIR_LLM_VERSION: AnalyzerVersion = {
	analyzerId: TURN_PAIR_LLM_DEF.id,
	major: 1,
	// 1.2: classify prompt now requests structured output via a forced tool call
	// (classify_turn) instead of "return only JSON". Robustness change for reasoning
	// models; prompt text changed, hence a version bump.
	// 1.3: tool-evidence channel (issue #12) — the classify prompt now carries the
	// turn's tool calls (name + truncated args) and failed-result error heads,
	// bounded to MAX_TOOL_EVIDENCE_PER_TURN. The prompt input changed, so the
	// input_key (and hence node version) changes; recomputed on the next run.
	// 1.4: learned frustration lexicon — a turn carrying a lexicon or lexicon-free
	// frustration signal is now enriched even when the deterministic score alone
	// would not have selected it, which is how a non-English correction reaches the
	// classifier at all. Selection only: a unit's source set is unchanged, so every
	// already-enriched turn keeps its identity and nothing is recomputed.
	// 1.5: event-centered enrichment context (issue #118, after LivePlan §II-B) —
	// the classify prompt now carries the turns since the previous trigger point
	// (trajectory signal, high-signal flag, or frustration hit), clamped by
	// EVIDENCE_SLICE_CEILING, instead of the escalated turn alone. tool-trajectory
	// joins the declared dependencies and its node's output key folds into every
	// unit's source set (as do the frustration nodes that already shaped selection
	// but never identity — an oversight this change fixes honestly). Prompt text
	// and unit inputs changed; recomputed on the next run.
	minor: 5,
	implementationKind: "in_process_llm",
	codeRef: "src/analyze/analyzers/turn-pair-llm/index.ts",
};

const PROMPTS: Record<string, PromptVersion> = {
	classify: { hash: CLASSIFY_PROMPT_HASH, content: CLASSIFY_PROMPT, role: "classify" },
};

interface EnrichMeta {
	userText: string;
	assistantText: string;
	correctionText: string | null;
	toolCalls: ToolCallEvidence[];
	toolResults: ToolResultEvidence[];
	/** Event-centered slice: turns since the previous trigger point (issue #118). */
	priorTurns: SliceTurn[];
	coreOutputKey: string;
	/**
	 * The output keys of the dependency nodes this unit was built from: the
	 * frustration hits that escalated the turn, the trajectory node whose signals
	 * bounded the slice, and the turn's core node.
	 *
	 * The source set already names them — that is what makes the unit's identity
	 * move when an upstream conclusion changes — but the *edge* is what lets a
	 * reader walk back from a conclusion to the evidence it was built from. The
	 * frustration hits matter most: a human mute silences a hit by marking it,
	 * and a conclusion drawn from a silenced hit has to be findable so that
	 * lifting the mute can hand the lineage head back to the conclusion that
	 * holds again (#325).
	 */
	consumedOutputKeys: string[];
}

export const turnPairLLMAnalyzer: Analyzer = {
	def: TURN_PAIR_LLM_DEF,
	version: TURN_PAIR_LLM_VERSION,
	prompts: PROMPTS,
	defaultConfig: {
		id: "",
		analyzerId: TURN_PAIR_LLM_DEF.id,
		configHash: computeConfigHash(DEFAULT_TURN_PAIR_LLM_CONFIG),
		configJson: DEFAULT_TURN_PAIR_LLM_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	// Term mutes are part of this analyzer's config: a muted term's hit must not
	// escalate a turn to the classifier, nor appear in the evidence slice (#325).
	consultsAssertions: ["term"],

	modelsForIdentity(config, modelTiers): string[] {
		const cfg = (config as unknown as TurnPairLLMConfig) ?? DEFAULT_TURN_PAIR_LLM_CONFIG;
		return [resolveModelSpec(cfg.tier, modelTiers)];
	},

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		const coreNodes = ctx.dependencyNodes[TURN_PAIR_CORE_DEF.id] ?? [];
		const pairs = await ctx.getTurnPairs(ctx.sessionId);
		const pairByUserId = new Map(pairs.map((p) => [p.userMessageId, p]));
		const config = (ctx.config as unknown as TurnPairLLMConfig) ?? DEFAULT_TURN_PAIR_LLM_CONFIG;

		// Frustration signal per turn, from the learned lexicon and the lexicon-free
		// markers. This *widens* selection: a turn whose only evidence is a French
		// correction or a row of question marks scores near zero deterministically,
		// and would never otherwise reach the classifier that can name its friction type.
		const frustrationBoost = new Map<string, number>();
		const frustrationIds: string[][] = [];
		// A muted term's hits are silenced (#325): a silenced hit must not
		// escalate a turn. It stays an *input* — the source set is unchanged, so
		// the unit keeps its identity — and it still marks a slice boundary: the
		// turn happened, and shrinking an unrelated turn's evidence slice because
		// a word was muted would be a change the operator never asked for.
		const muted = await getMutedNodeIds(ctx.db);
		const hitOutputKeys: string[] = [];
		for (const node of ctx.dependencyNodes[TURN_FRUSTRATION_DEF.id] ?? []) {
			let hit: TurnFrustrationProperties;
			try {
				hit = JSON.parse(node.content_json) as TurnFrustrationProperties;
			} catch {
				continue;
			}
			if (!hit.user_message_id) continue;
			frustrationIds.push([hit.user_message_id]);
			hitOutputKeys.push(node.output_key);
			if (muted.has(node.id)) continue;
			if (hit.polarity !== "frustration") continue;
			frustrationBoost.set(hit.user_message_id, (frustrationBoost.get(hit.user_message_id) ?? 0) + hit.weight);
		}

		// Trajectory-signal trigger points (issue #118): each signal carries the
		// message ids it participated in — the event boundaries for evidence slices.
		const trajectoryIds: string[][] = (ctx.dependencyNodes[TOOL_TRAJECTORY_DEF.id] ?? []).flatMap((node) => {
			try {
				const signals = (JSON.parse(node.content_json) as ToolTrajectoryProperties).signals ?? [];
				return signals.map((s) => s.messageIds ?? []);
			} catch {
				return [];
			}
		});

		// Collect every pair the deterministic pass flagged, plus every pair the
		// lexicon flagged, that still maps to a turn in the transcript.
		const candidates: { node: typeof coreNodes[number]; props: TurnPairCoreProperties; rank: number }[] = [];
		for (const node of coreNodes) {
			let props: TurnPairCoreProperties;
			try {
				props = JSON.parse(node.content_json) as TurnPairCoreProperties;
			} catch {
				continue;
			}
			const boost = frustrationBoost.get(props.user_message_id) ?? 0;
			if (!props.high_signal && boost === 0) continue;
			if (!pairByUserId.has(props.user_message_id)) continue;
			candidates.push({ node, props, rank: props.friction_score + boost });
		}

		// Cost guard: enrich up to a length-aware cap (minPairFraction * total, clamped to ceiling),
		// highest friction first (ties broken by pair order so selection is deterministic across runs).
		candidates.sort((a, b) => b.rank - a.rank || a.props.pair_index - b.props.pair_index);
		const cap = computeEnrichCap(candidates.length, config);
		const selected = candidates.slice(0, cap);

		// Event-centered slice boundaries (issue #118): every deterministic detection
		// event — trajectory signal, high-signal flag, frustration hit — marks where a
		// new slice begins. An escalated turn reads its run-up since the previous
		// trigger, clamped by EVIDENCE_SLICE_CEILING.
		const messageIdToPairIndex = buildMessageIdToPairIndex(pairs);
		const triggers = collectTriggerPairIndexes(messageIdToPairIndex, [
			...trajectoryIds,
			...frustrationIds,
			...coreNodes.flatMap((node) => {
				try {
					const props = JSON.parse(node.content_json) as TurnPairCoreProperties;
					return props.high_signal && props.user_message_id ? [[props.user_message_id]] : [];
				} catch {
					return [];
				}
			}),
		]);
		const pairByIndex = new Map(pairs.map((p) => [p.index, p]));

		const units: AnalysisUnit[] = [];
		for (const { node, props } of selected) {
			const pair = pairByUserId.get(props.user_message_id)!;
			// The run-up: [previous trigger .. this turn), current turn excluded (it is
			// rendered in full below). Clamped by the ceiling for sparse-trigger sessions.
			const currentIndex = messageIdToPairIndex.get(pair.userMessageId) ?? -1;
			const priorTurns: SliceTurn[] = currentIndex <= 0 ? [] : (() => {
				const start = sliceStartIndex(triggers, currentIndex);
				const out: SliceTurn[] = [];
				for (let i = start; i < Math.min(currentIndex, pairs.length); i++) {
					const p = pairByIndex.get(i);
					if (!p) continue;
					out.push({ index: p.index, userText: p.userText, assistantText: p.assistantText });
				}
				return out.slice(-EVIDENCE_SLICE_CEILING);
			})();
			// Sources fold in every node whose conclusion shaped this unit: the escalated
			// turn's core metrics, plus the trajectory and frustration nodes whose signals
			// selected it and bound its slice. A changed upstream output re-identifies the
			// unit and forces honest recomputation.
			const sources: SourceRef[] = [
				{ kind: "analysis_node", id: node.output_key },
				...(ctx.dependencyNodes[TOOL_TRAJECTORY_DEF.id] ?? []).map((n) => ({ kind: "analysis_node" as const, id: n.output_key })),
				...(ctx.dependencyNodes[TURN_FRUSTRATION_DEF.id] ?? []).map((n) => ({ kind: "analysis_node" as const, id: n.output_key })),
			];
			const meta: EnrichMeta = {
				userText: pair.userText,
				assistantText: pair.assistantText,
				correctionText: props.correction_text,
				toolCalls: pair.toolCalls.map((tc): ToolCallEvidence => ({
					name: tc.name,
					argumentsPreview: tc.argumentsPreview,
				})),
				toolResults: pair.toolResults.map((tr): ToolResultEvidence => ({
					toolName: tr.toolName,
					isError: tr.isError,
					errorHead: tr.errorHead,
				})),
				priorTurns,
				coreOutputKey: node.output_key,
				// The evidence trail: every dependency node whose conclusion shaped
				// this unit. The hits first — they are what a human mute silences.
				consumedOutputKeys: [
					...hitOutputKeys,
					...(ctx.dependencyNodes[TOOL_TRAJECTORY_DEF.id] ?? []).map((n) => n.output_key),
					node.output_key,
				],
			};
			units.push({
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "message",
				anchorRef: props.user_message_id,
				meta: meta as unknown as Record<string, unknown>,
			});
		}
		return units;
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = (ctx.config.configJson as unknown as TurnPairLLMConfig) ?? DEFAULT_TURN_PAIR_LLM_CONFIG;
		const meta = unit.meta as unknown as EnrichMeta;

		const response = await ctx.llm({
			model: resolveModelSpec(config.tier, ctx.modelTiers),
			system: ctx.prompts["classify"] ?? CLASSIFY_PROMPT,
			user: buildClassifyPrompt({
				userText: meta.userText,
				assistantText: meta.assistantText,
				correctionText: meta.correctionText,
				toolCalls: meta.toolCalls,
				toolResults: meta.toolResults,
				priorTurns: meta.priorTurns,
			}),
			temperature: config.temperature,
			maxTokens: 500,
			tool: CLASSIFY_TOOL,
		});

		const properties: TurnPairLLMProperties = {
			...(response.structured
				? parseClassifyObject(response.structured as Record<string, unknown>)
				: parseClassifyResponse(response.text)),
			user_message_id: unit.anchorRef,
		};

		return {
			nodeKind: "classification",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "message",
			anchorRef: unit.anchorRef,
			modelUsed: response.model,
			costUsd: response.costUsd,
			tokensUsed: response.tokensUsed,
			inputTokens: response.inputTokens,
			cachedInputTokens: response.cachedInputTokens,
			outputTokens: response.outputTokens,
			durationMs: response.durationMs,
			edges: [
				{ toRefKind: REF_KINDS.MESSAGE, toRefId: unit.anchorRef, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
				// The evidence trail: the dependency nodes this classification was
				// built from. The frustration hits come first — a human mute silences
				// a hit by marking it, and the conclusion drawn from a silenced hit
				// has to be findable from the hit so that lifting the mute can hand
				// the lineage head back to the conclusion that holds again (#325).
				...meta.consumedOutputKeys.map((key, i) => ({
					toRefKind: REF_KINDS.ANALYSIS_NODE,
					toRefId: key,
					edgeKind: EDGE_KINDS.CONSUMES,
					ordinal: i + 1,
				})),
				{ toRefKind: REF_KINDS.PROMPT_VERSION, toRefId: CLASSIFY_PROMPT_HASH, edgeKind: EDGE_KINDS.USES_PROMPT, ordinal: meta.consumedOutputKeys.length + 1 },
			],
		};
	},
};
