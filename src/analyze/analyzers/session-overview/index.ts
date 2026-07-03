/**
 * session-overview — one summary node per session, producing improvement
 * proposals. Depends on turn-pair-core and turn-pair-llm.
 *
 * Strategy: build a structured digest. If it fits the budget, a single reduce
 * call produces the summary and proposals. Otherwise the digest is split into
 * segments, each summarised by a cheap model (map), then a mid model combines
 * the segment summaries plus aggregate stats into the final result (reduce).
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
import { extractJsonObject } from "../turn-pair-llm/prompt.js";
import { TURN_PAIR_CORE_DEF, type TurnPairCoreProperties } from "../turn-pair-core/index.js";
import { TURN_PAIR_LLM_DEF } from "../turn-pair-llm/index.js";
import { TOOL_TRAJECTORY_DEF } from "../tool-trajectory/index.js";
import { buildDigest, splitDigest } from "./digest.js";
import { MAP_PROMPT, MAP_PROMPT_HASH, MAP_TOOL, buildMapPrompt, parseMapResponse, parseMapObject, type MapSummary } from "./prompt-map.js";
import {
	REDUCE_PROMPT,
	REDUCE_PROMPT_HASH,
	REDUCE_TOOL,
	buildReducePrompt,
	parseReduceResponse,
	parseReduceObject,
	type SessionOverviewProperties,
} from "./prompt-reduce.js";
import { DEFAULT_SESSION_OVERVIEW_CONFIG, type SessionOverviewConfig } from "./config.js";
import {
	selectCrossSessionContrast,
	formatContrastContext,
	type SiblingContrast,
} from "./cross-session.js";

export const SESSION_OVERVIEW_DEF: AnalyzerDef = {
	id: "session-overview",
	label: "Session Analysis & Proposals",
	description:
		"Map-reduces a session into a summary, positive signals, and ranked improvement proposals (enumerate-then-propose). Consumes turn-pair-core, turn-pair-llm, and tool-trajectory nodes; always emits a node, even for clean sessions.",
	anchorSpan: "full_session",
	dependencies: [TURN_PAIR_CORE_DEF.id, TURN_PAIR_LLM_DEF.id, TOOL_TRAJECTORY_DEF.id],
};

export const SESSION_OVERVIEW_VERSION: AnalyzerVersion = {
	analyzerId: SESSION_OVERVIEW_DEF.id,
	major: 1,
	// 1.1: additively attach `source_message_ids` (the session's high-signal turn
	// ids, highest-friction first) to every proposal, so the proposal-validate
	// analyzer (issue #6) has a concrete replay set. Minor: output gains a field,
	// the synthesis itself is unchanged.
	// 1.2: map/reduce prompts now request structured output via a forced tool call
	// (submit_segment_summary / submit_session_analysis) instead of "return only
	// JSON", so reasoning models stop returning prose. Behaviour-preserving
	// robustness change; prompt text changed, hence a version bump.
	// 1.3: tool-evidence channel (issue #12) — the per-pair digest line now appends
	// a tool-evidence fragment (tool name + truncated args + failed-result error
	// head) for high-signal/failing pairs. The digest feeds the reduce prompt, so
	// the input_key (and node version) changes; recomputed on the next run.
	// 1.4: cross-session success/failure contrast (issue #10) — when a session's
	// repo/`cwd` also contains smooth sibling sessions, plan() deterministically
	// selects up to N of them (from their RAW messages, never their analysis nodes)
	// and folds them into the source set as `session`-kind refs whose id embeds a
	// hash of the contrast digest. The reduce step is handed that digest as negative
	// examples. Identity stays reproducible: the siblings are part of the source set,
	// derived deterministically from ingested content. Minor: additive contrast
	// context; the per-session synthesis contract is unchanged.
	minor: 4,
	implementationKind: "in_process_llm",
	codeRef: "src/analyze/analyzers/session-overview/index.ts",
};

const PROMPTS: Record<string, PromptVersion> = {
	map: { hash: MAP_PROMPT_HASH, content: MAP_PROMPT, role: "map" },
	reduce: { hash: REDUCE_PROMPT_HASH, content: REDUCE_PROMPT, role: "reduce" },
};

export const sessionOverviewAnalyzer: Analyzer = {
	def: SESSION_OVERVIEW_DEF,
	version: SESSION_OVERVIEW_VERSION,
	prompts: PROMPTS,
	defaultConfig: {
		id: "",
		analyzerId: SESSION_OVERVIEW_DEF.id,
		configHash: computeConfigHash(DEFAULT_SESSION_OVERVIEW_CONFIG),
		configJson: DEFAULT_SESSION_OVERVIEW_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	modelsForIdentity(config, modelTiers): string[] {
		const cfg = (config as unknown as SessionOverviewConfig) ?? DEFAULT_SESSION_OVERVIEW_CONFIG;
		return [resolveModelSpec(cfg.mapTier, modelTiers), resolveModelSpec(cfg.reduceTier, modelTiers)];
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		const core = (ctx.dependencyNodes[TURN_PAIR_CORE_DEF.id] ?? []).slice().sort((a, b) => a.id.localeCompare(b.id));
		if (core.length === 0) return [];
		const llm = (ctx.dependencyNodes[TURN_PAIR_LLM_DEF.id] ?? []).slice().sort((a, b) => a.id.localeCompare(b.id));
		const traj = (ctx.dependencyNodes[TOOL_TRAJECTORY_DEF.id] ?? []).slice().sort((a, b) => a.id.localeCompare(b.id));

		const sources: SourceRef[] = [
			...core.map((n) => ({ kind: "analysis_node" as const, id: n.output_key })),
			...llm.map((n) => ({ kind: "analysis_node" as const, id: n.output_key })),
			...traj.map((n) => ({ kind: "analysis_node" as const, id: n.output_key })),
		];

		// Cross-session contrast (issue #10): deterministically fold up to N smooth
		// sibling sessions in the same repo into the source set, so pulling their
		// contrast digest into this node's synthesis keeps identity content-addressed
		// and reproducible. Derived from sibling RAW messages (present after ingest),
		// never from their analysis nodes — so it is order-independent and acyclic.
		const cfg = (ctx.config as unknown as SessionOverviewConfig) ?? DEFAULT_SESSION_OVERVIEW_CONFIG;
		const contrast = selectCrossSessionContrast(ctx.db, ctx.sessionId, cfg);
		sources.push(...contrast.sourceRefs);

		return [
			{
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
				meta: contrast.siblings.length > 0 ? { crossSessionContrast: contrast.siblings } : undefined,
			},
		];
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = (ctx.config.configJson as unknown as SessionOverviewConfig) ?? DEFAULT_SESSION_OVERVIEW_CONFIG;
		const coreNodes = ctx.getDependencyNodes(TURN_PAIR_CORE_DEF.id);
		const llmNodes = ctx.getDependencyNodes(TURN_PAIR_LLM_DEF.id);
		const trajectoryNodes = ctx.getDependencyNodes(TOOL_TRAJECTORY_DEF.id);
		const messages = ctx.getSessionMessages(ctx.sessionId);

		const digest = buildDigest({ sessionId: ctx.sessionId, messages, coreNodes, llmNodes, trajectoryNodes });
		const statsText = JSON.stringify(
			{
				pairs: digest.pairCount,
				high_signal: digest.frictionCount,
				corrections: digest.correctionCount,
				tool_failures: digest.toolFailureCount,
				trajectory_signals: digest.trajectorySignalCount,
				compactions: digest.compactionCount,
				positive_signals: digest.positiveSignals,
			},
			null,
			2,
		);

		let costUsd = 0;
		let tokensUsed = 0;
		let modelUsed: string | undefined;
		const usedPromptHashes: string[] = [REDUCE_PROMPT_HASH];

		let reduceInput: string;
		if (digest.totalChars > config.mapReduceOverChars) {
			const segments = splitDigest(digest, config.segmentChars).slice(0, config.maxSegments);
			const summaries: MapSummary[] = [];
			for (const seg of segments) {
				const res = await ctx.llm({
					model: resolveModelSpec(config.mapTier, ctx.modelTiers),
					system: ctx.prompts["map"] ?? MAP_PROMPT,
					user: buildMapPrompt(seg.text),
					temperature: config.temperature,
					maxTokens: 800,
					tool: MAP_TOOL,
				});
				costUsd += res.costUsd;
				tokensUsed += res.tokensUsed;
				modelUsed = res.model;
				summaries.push(
					res.structured
						? parseMapObject(res.structured as Record<string, unknown>)
						: parseMapResponse(res.text, extractJsonObject),
				);
			}
			reduceInput = JSON.stringify(
				summaries.map((s, i) => ({ segment: i, summary: s.segment_summary, notable: s.notable_points })),
				null,
				2,
			);
			usedPromptHashes.unshift(MAP_PROMPT_HASH);
		} else {
			reduceInput = digest.text;
		}

		// Cross-session contrast digest (issue #10), attached by plan() from the
		// smooth sibling sessions already folded into this unit's source set.
		const siblings = (unit.meta?.["crossSessionContrast"] as SiblingContrast[] | undefined) ?? [];
		const contrastContext = formatContrastContext(siblings);

		const reduceRes = await ctx.llm({
			model: resolveModelSpec(config.reduceTier, ctx.modelTiers),
			system: ctx.prompts["reduce"] ?? REDUCE_PROMPT,
			user: buildReducePrompt({ digestOrSummaries: reduceInput, stats: statsText, positiveSignals: digest.positiveSignals, contrastContext }),
			temperature: config.temperature,
			maxTokens: 2000,
			tool: REDUCE_TOOL,
		});
		costUsd += reduceRes.costUsd;
		tokensUsed += reduceRes.tokensUsed;
		modelUsed = reduceRes.model;

		// Prefer the forced tool call's structured arguments; fall back to parsing
		// JSON out of the text channel for models/providers that answered in prose.
		const properties: SessionOverviewProperties = reduceRes.structured
			? parseReduceObject(reduceRes.structured as Record<string, unknown>)
			: parseReduceResponse(reduceRes.text, extractJsonObject);
		properties.stats = {
			pairs: digest.pairCount,
			high_signal: digest.frictionCount,
			corrections: digest.correctionCount,
			tool_failures: digest.toolFailureCount,
			trajectory_signals: digest.trajectorySignalCount,
			positive_signals: digest.positiveSignals,
		};

		// Deterministically attach the session's high-signal turn ids (highest
		// friction first) to every proposal as its replay set for proposal-validate
		// (issue #6). This is computed from the deterministic core metrics — never
		// from the model — so it stays reproducible and does not depend on the LLM
		// citing turn ids it never saw. The mapping is deliberately coarse
		// (session-level, not per-proposal): failure-step attribution is unreliable,
		// and replaying a candidate rule against the session's friction turns is a
		// fair, discriminating test of whether the rule averts the friction.
		const frictionMessageIds = collectHighSignalMessageIds(coreNodes);
		for (const proposal of properties.improvement_proposals) {
			proposal["source_message_ids"] = frictionMessageIds;
		}

		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
		];
		let ordinal = 1;
		for (const n of [...coreNodes, ...llmNodes, ...trajectoryNodes]) {
			edges.push({ toRefKind: REF_KINDS.ANALYSIS_NODE, toRefId: n.output_key, edgeKind: EDGE_KINDS.CONSUMES, ordinal: ordinal++ });
		}
		for (const h of usedPromptHashes) {
			edges.push({ toRefKind: REF_KINDS.PROMPT_VERSION, toRefId: h, edgeKind: EDGE_KINDS.USES_PROMPT, ordinal: ordinal++ });
		}
		// Provenance for the cross-session contrast: a `contrasts_with` edge to each
		// smooth sibling session used as a negative example. Identity already commits
		// to these siblings via the source set; the edge makes the trail navigable.
		for (const sibling of siblings) {
			edges.push({ toRefKind: REF_KINDS.SESSION, toRefId: sibling.sessionId, edgeKind: EDGE_KINDS.CONTRASTS_WITH, ordinal: ordinal++ });
		}

		return {
			nodeKind: "summary",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			modelUsed,
			costUsd,
			tokensUsed,
			edges,
		};
	},
};

/**
 * The high-signal turns' user-message ids, highest friction first. This is the
 * replay set attached to each proposal for offline validation. Ties broken by
 * pair order for a deterministic, reproducible ordering.
 */
function collectHighSignalMessageIds(coreNodes: readonly { content_json: string }[]): string[] {
	const props: TurnPairCoreProperties[] = [];
	for (const n of coreNodes) {
		try {
			props.push(JSON.parse(n.content_json) as TurnPairCoreProperties);
		} catch {
			/* skip unparseable */
		}
	}
	return props
		.filter((p) => p.high_signal)
		.sort((a, b) => b.friction_score - a.friction_score || a.pair_index - b.pair_index)
		.map((p) => p.user_message_id);
}
