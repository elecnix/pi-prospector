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
	AnalysisNodeRow,
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
import { FAILURE_MODES_DEF } from "../failure-modes/index.js";
import { TURN_FRUSTRATION_DEF } from "../turn-frustration/index.js";
import { ASSISTANT_COGNITION_DEF } from "../assistant-cognition/index.js";
import { PLAN_COMPLIANCE_DEF } from "../plan-compliance/index.js";
import { PHASE_TRAJECTORY_DEF } from "../phase-trajectory/index.js";
import { buildDigest, splitDigest } from "./digest.js";
import type { AsyncDatabase } from "../../../db/async-db.js";
import { currentHits } from "../../../db/muted-terms.js";
import { pricedHits } from "../../hit-reading.js";
import { MAP_PROMPT, MAP_PROMPT_HASH, MAP_TOOL, buildMapPrompt, parseMapResponse, parseMapObject, type MapSummary } from "./prompt-map.js";
import {
	REDUCE_PROMPT,
	REDUCE_PROMPT_HASH,
	REDUCE_TOOL,
	buildReducePrompt,
	parseReduceResponse,
	parseReduceObject,
	SessionOverviewProperties,
} from "./prompt-reduce.js";
import { DEFAULT_SESSION_OVERVIEW_CONFIG, type SessionOverviewConfig } from "./config.js";
import {
	selectCrossSessionContrast,
	formatContrastContext,
	getSessionCwd,
	type SiblingContrast,
	type CwdSmoothnessCache,
} from "./cross-session.js";
import { selectPriorOccurrences, formatRecallContext, type RecalledWindow, type RecallQuery } from "./recall.js";

export const SESSION_OVERVIEW_DEF: AnalyzerDef = {
	id: "session-overview",
	label: "Session Analysis & Proposals",
	description:
		"Map-reduces a session into a summary, positive signals, and ranked improvement proposals (enumerate-then-propose). Consumes turn-pair-core, turn-pair-llm, tool-trajectory, failure-modes, turn-frustration, assistant-cognition, and user-reply-acts nodes; always emits a node, even for clean sessions.",
	anchorSpan: "full_session",
	dependencies: [TURN_PAIR_CORE_DEF.id, TURN_PAIR_LLM_DEF.id, TOOL_TRAJECTORY_DEF.id, FAILURE_MODES_DEF.id, TURN_FRUSTRATION_DEF.id, ASSISTANT_COGNITION_DEF.id, PLAN_COMPLIANCE_DEF.id, PHASE_TRAJECTORY_DEF.id, "user-reply-acts"],
	outputSchema: SessionOverviewProperties,
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
	// 1.5: learned frustration lexicon — the digest now carries per-turn
	// `frustration=[term:category/lang]` fragments and session counts, from
	// turn-frustration. This is what lets the synthesiser see friction expressed in
	// a language the shipped regex has no patterns for, or with no words at all.
	// Sessions with no such signal keep an unchanged source set and are untouched.
	// 1.6: user-reply-acts in the digest (issue #131) — the digest now carries a
	// `### Reply acts` section showing what the user did with each assistant
	// response (accept, refuse, ask, command, provide information). The reduce
	// prompt notes this context is available. The dependency is declared by string
	// literal because user-reply-acts is a custom analyzer, not a built-in.
	// 1.7: failed generations (issue #159) — the digest now carries a `### Failures`
	// section and a `turn_failures=` header line from failure-modes, and the
	// proposal contract gains the `extension` target type. Until now a turn that
	// failed outright was invisible to the synthesiser: no tool ran, so nothing in
	// the trajectory recorded it and the turn read as a short reply. Minor: the
	// digest and prompt gain a channel; the synthesis contract is otherwise
	// unchanged.
	// 1.8: assistant cognition in the digest (issue #210) — the digest now carries
	// an `### Assistant cognition` section built from assistant-cognition nodes:
	// one capped line per signalling turn with confusion/indecision grades and
	// verbatim-validated surprise quotes. Each class points the synthesiser at an
	// artifact to fix (confusion → missing/unclear standing instruction or doc;
	// indecision → ambiguous instructions or competing conventions; surprise →
	// wrong assumption baked into standing instructions or a misleading tool
	// description). The dependency is declared and its output keys fold into the
	// source set, so changed cognition outputs correctly mark overviews stale.
	// The section is bounded by `maxCognitionEntries`, mirroring turn-pair-llm's
	// enrichment ceiling. Minor: additive channel; synthesis otherwise unchanged.
	// 1.9: plan-compliance in the digest (issue #121) — when phase-trajectory has
	// classified this session, the header gains one bounded `plan_compliance:`
	// line (PC with its PPC/POC/PPF factors and any skipped phases) so a proposal
	// can cite "never validated" with a number behind it. A ranking/contrast
	// feature, never an outcome label. The dependency is declared and the node's
	// output key folds into the source set. Minor: additive channel; synthesis
	// otherwise unchanged.
	// 1.10: event-centered trajectory evidence slices (issue #118, after LivePlan
	// §II-B) — each trajectory signal rendered into the digest now carries the
	// turns since the previous trigger of any kind (trajectory signal, high-signal
	// flag, frustration hit, or phase transition when phase-trajectory has run),
	// clamped by EVIDENCE_SLICE_CEILING for sparse-trigger sessions, instead of no
	// turn context at all. Digest volume scales with signal density (one slice per
	// signal) rather than with a fixed positional cap. phase-trajectory joins the
	// declared dependencies and its node's output key folds into the source set.
	// Minor: additive channel; the synthesis contract is otherwise unchanged.
	// 1.11: a muted lexicon term stops counting toward the digest (issue #321).
	// The digest lists the frustration terms a turn carried and counts the turns
	// that carried one, so a term the operator rejected must not appear in
	// either. The hits are also read at their current generation, so an unmute,
	// which leaves the muted-era hit live beside the new one, does not list the
	// signal twice.
	// 1.12: a term carried by more than a tenth of the corpus's turns stops
	// counting too, which retires the hand-written list of English function words
	// that used to do it (issue #321). The digest is handed the priced reading and
	// no longer resolves mutes or generations itself, so it cannot disagree with
	// the other readers about which signals exist. The source set names the current
	// generation of each upstream rather than every live one. Minor: the digest
	// content narrows; the synthesis contract is otherwise unchanged.
	// 1.13: prior-occurrence recall (RAW-RAG, arXiv:2610.30755) — opt-in via
	// `recallPriorOccurrences`. Raw windows of earlier sessions that resemble this
	// session's friction turns are folded into the source set (message ref + window
	// hash) and handed to the reduce step as PRIOR OCCURRENCES, with a `recalls` edge
	// per message. Off by default, so the source set and the synthesis are unchanged
	// until it is enabled. Minor: additive channel.
	minor: 13,
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

	// Term mutes are part of this analyzer's config: a muted term's hit must not
	// reach the digest or the synthesis (#325).
	consultsAssertions: ["term"],

	modelsForIdentity(config, modelTiers): string[] {
		const cfg = (config as unknown as SessionOverviewConfig) ?? DEFAULT_SESSION_OVERVIEW_CONFIG;
		return [resolveModelSpec(cfg.mapTier, modelTiers), resolveModelSpec(cfg.reduceTier, modelTiers)];
	},

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		// A source set names each upstream's *current* conclusion, not its whole
		// lineage. A revise leaves the superseded node live beside its replacement,
		// so folding in every live node would make this unit's identity depend on how
		// many times an upstream happened to be revised rather than on what it
		// concluded — and a reader below draws only on the current generation.
		const current = (nodes: readonly AnalysisNodeRow[] | undefined): AnalysisNodeRow[] =>
			currentHits(nodes ?? []).sort((a, b) => a.id.localeCompare(b.id));

		const core = current(ctx.dependencyNodes[TURN_PAIR_CORE_DEF.id]);
		if (core.length === 0) return [];
		const llm = current(ctx.dependencyNodes[TURN_PAIR_LLM_DEF.id]);
		const traj = current(ctx.dependencyNodes[TOOL_TRAJECTORY_DEF.id]);
		const failures = current(ctx.dependencyNodes[FAILURE_MODES_DEF.id]);
		const frustration = current(ctx.dependencyNodes[TURN_FRUSTRATION_DEF.id]);
		const replyActs = current(ctx.dependencyNodes["user-reply-acts"]);
		const cognition = current(ctx.dependencyNodes[ASSISTANT_COGNITION_DEF.id]);
		const compliance = current(ctx.dependencyNodes[PLAN_COMPLIANCE_DEF.id]);
		const phases = current(ctx.dependencyNodes[PHASE_TRAJECTORY_DEF.id]);

		const sources: SourceRef[] = [
			...core.map((n) => ({ kind: "analysis_node" as const, id: n.output_key })),
			...llm.map((n) => ({ kind: "analysis_node" as const, id: n.output_key })),
			...traj.map((n) => ({ kind: "analysis_node" as const, id: n.output_key })),
			...failures.map((n) => ({ kind: "analysis_node" as const, id: n.output_key })),
			...frustration.map((n) => ({ kind: "analysis_node" as const, id: n.output_key })),
			...replyActs.map((n) => ({ kind: "analysis_node" as const, id: n.output_key })),
			...cognition.map((n) => ({ kind: "analysis_node" as const, id: n.output_key })),
			...compliance.map((n) => ({ kind: "analysis_node" as const, id: n.output_key })),
			...phases.map((n) => ({ kind: "analysis_node" as const, id: n.output_key })),
		];

		// Cross-session contrast (issue #10): deterministically fold up to N smooth
		// sibling sessions in the same repo into the source set, so pulling their
		// contrast digest into this node's synthesis keeps identity content-addressed
		// and reproducible. Derived from sibling RAW messages (present after ingest),
		// never from their analysis nodes — so it is order-independent and acyclic.
		const cfg = (ctx.config as unknown as SessionOverviewConfig) ?? DEFAULT_SESSION_OVERVIEW_CONFIG;
		// Sibling smoothness is assessed from a narrow SQL projection (no
		// `content_thinking`), never via `getTurnPairs`, and shared per-`cwd` so
		// concurrent sessions in the same repo scan the sibling set once (#232).
		let cwdCache: CwdSmoothnessCache | undefined;
		if (ctx.getCwdSmoothnessCache) {
			const cwd = await getSessionCwd(ctx.db, ctx.sessionId);
			if (cwd) cwdCache = await ctx.getCwdSmoothnessCache(cwd, ctx.sessionId, cfg.minSiblingPairs);
		}
		const contrast = await selectCrossSessionContrast(ctx.db, ctx.sessionId, cfg, (sid) => ctx.getTurnPairs(sid), cwdCache);
		sources.push(...contrast.sourceRefs);

		// Prior-occurrence recall: raw windows from earlier sessions that resemble this
		// session's friction turns (recall.ts). Folded into the source set like the
		// contrast siblings, so identity commits to the exact text shown.
		const recallQueries = await frictionQueries(ctx.db, collectHighSignalMessageIds(core), cfg.recallMaxQueries);
		const recall = await selectPriorOccurrences(ctx.db, ctx.sessionId, recallQueries, cfg);
		sources.push(...recall.sourceRefs);

		return [
			{
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
				meta:
					contrast.siblings.length > 0 || recall.windows.length > 0
						? {
								...(contrast.siblings.length > 0 ? { crossSessionContrast: contrast.siblings } : {}),
								...(recall.windows.length > 0 ? { priorOccurrences: recall.windows } : {}),
							}
						: undefined,
			},
		];
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = (ctx.config.configJson as unknown as SessionOverviewConfig) ?? DEFAULT_SESSION_OVERVIEW_CONFIG;
		const coreNodes = await ctx.getDependencyNodes(TURN_PAIR_CORE_DEF.id);
		const llmNodes = await ctx.getDependencyNodes(TURN_PAIR_LLM_DEF.id);
		const trajectoryNodes = await ctx.getDependencyNodes(TOOL_TRAJECTORY_DEF.id);
		const failureNodes = await ctx.getDependencyNodes(FAILURE_MODES_DEF.id);
		const frustrationNodes = await ctx.getDependencyNodes(TURN_FRUSTRATION_DEF.id);
		// A muted term's hits are silenced (#325): they stay inputs — the source
		// set is unchanged — but they do not reach the digest or the synthesis.
		const replyActsNodes = await ctx.getDependencyNodes("user-reply-acts");
		const cognitionNodes = await ctx.getDependencyNodes(ASSISTANT_COGNITION_DEF.id);
		const complianceNodes = await ctx.getDependencyNodes(PLAN_COMPLIANCE_DEF.id);
		const phaseNodes = await ctx.getDependencyNodes(PHASE_TRAJECTORY_DEF.id);
		const messages = await ctx.getSessionMessages(ctx.sessionId);

		// The digest is handed the hits that count, not the whole dependency list:
		// the current generation, the operator's mutes honoured, and each term priced
		// by the share of turns that carry it. Resolving it in one place is what keeps
		// the digest, the accumulated friction, and the ranking from disagreeing about
		// which signals exist.
		const countedFrustrationNodes = await pricedHits(ctx.db, frustrationNodes);

		const digest = buildDigest({
			sessionId: ctx.sessionId,
			messages,
			turnPairs: await ctx.getTurnPairs(ctx.sessionId),
			coreNodes,
			llmNodes,
			trajectoryNodes,
			failureNodes,
			frustrationNodes: countedFrustrationNodes,
			replyActsNodes,
			cognitionNodes,
			complianceNodes,
			phaseNodes,
			maxCognitionEntries: config.maxCognitionEntries,
		});
		const statsText = JSON.stringify(
			{
				pairs: digest.pairCount,
				high_signal: digest.frictionCount,
				corrections: digest.correctionCount,
				tool_failures: digest.toolFailureCount,
				trajectory_signals: digest.trajectorySignalCount,
				turn_failures: digest.turnFailureCount,
				frustration_signals: digest.frustrationSignalCount,
				frustration_languages: digest.frustrationLanguages,
				compactions: digest.compactionCount,
				positive_signals: digest.positiveSignals,
			},
			null,
			2,
		);

		let costUsd = 0;
		let tokensUsed = 0;
		let inputTokens = 0;
		let cachedInputTokens = 0;
		let outputTokens = 0;
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
				inputTokens += res.inputTokens ?? 0;
				cachedInputTokens += res.cachedInputTokens ?? 0;
				outputTokens += res.outputTokens ?? 0;
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
		const recalled = (unit.meta?.["priorOccurrences"] as RecalledWindow[] | undefined) ?? [];
		const recallContext = formatRecallContext(recalled);

		const reduceRes = await ctx.llm({
			model: resolveModelSpec(config.reduceTier, ctx.modelTiers),
			system: ctx.prompts["reduce"] ?? REDUCE_PROMPT,
			user: buildReducePrompt({ digestOrSummaries: reduceInput, stats: statsText, positiveSignals: digest.positiveSignals, contrastContext, recallContext }),
			temperature: config.temperature,
			maxTokens: 2000,
			tool: REDUCE_TOOL,
		});
		costUsd += reduceRes.costUsd;
		tokensUsed += reduceRes.tokensUsed;
		inputTokens += reduceRes.inputTokens ?? 0;
		cachedInputTokens += reduceRes.cachedInputTokens ?? 0;
		outputTokens += reduceRes.outputTokens ?? 0;
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
			turn_failures: digest.turnFailureCount,
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
		for (const n of [...coreNodes, ...llmNodes, ...trajectoryNodes, ...failureNodes, ...frustrationNodes, ...replyActsNodes, ...cognitionNodes, ...complianceNodes, ...phaseNodes]) {
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

		// Provenance for the recalled windows: a `recalls` edge to each earlier message.
		for (const w of recalled) {
			edges.push({ toRefKind: REF_KINDS.MESSAGE, toRefId: w.messageId, edgeKind: EDGE_KINDS.RECALLS, ordinal: ordinal++ });
		}

		return {
			nodeKind: "summary",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			modelUsed,
			costUsd,
			tokensUsed,
			inputTokens,
			cachedInputTokens,
			outputTokens,
			edges,
		};
	},
};

/** The text of the given friction turns, in the order given, capped at `max`; ids that no longer resolve are dropped. */
async function frictionQueries(db: AsyncDatabase, messageIds: readonly string[], max: number): Promise<RecallQuery[]> {
	const stmt = db.prepare("SELECT content_text FROM messages WHERE id = ?");
	const queries: RecallQuery[] = [];
	for (const id of messageIds.slice(0, Math.max(0, max))) {
		const row = (await stmt.get(id)) as { content_text: string | null } | undefined;
		if (row?.content_text && row.content_text.trim().length > 0) queries.push({ messageId: id, text: row.content_text });
	}
	return queries;
}

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
