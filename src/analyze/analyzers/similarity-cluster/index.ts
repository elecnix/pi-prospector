/**
 * similarity-cluster — deterministic near-duplicate text clustering
 * (issue #145).
 *
 * Detects clusters of near-similar user prompts, normalised tool calls, and
 * tool results ACROSS sessions sharing a repo (`cwd`) and WITHIN a session,
 * using the four-stage near-miss pipeline adapted from clone detection
 * (tokenise & normalise → rarest-shingle candidate nomination → length-band
 * prune + LCS score → exact-class/pair grouping). NO LLM: every stage is a
 * pure function, so nodes cost nothing and recompute deterministically.
 *
 * Cross-session scope follows the sanctioned contrast mechanism
 * (`session-overview/cross-session.ts`): plan() reads sibling RAW messages
 * deterministically through `ctx.db`, distils each sibling into an item
 * fingerprint, and folds those fingerprints into the unit's source set as
 * `session`-kind refs — so identity commits to exact sibling content and
 * reproduces across a DB rebuild, while the graph never depends on whether a
 * sibling has been analysed yet. Each session emits ONE node holding the
 * clusters its own items participate in; proposals follow the deterministic
 * analyzers' convention (embedded `improvement_proposals`, kind `proposal`
 * when any clear the gates, `metric` otherwise). A session whose repo group
 * exceeds `maxSessions` siblings sees only the first `maxSessions` (id order).
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
	MessageRow,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeConfigHash, computeSourceSetHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import {
	DEFAULT_SIMILARITY_CLUSTER_CONFIG,
	SimilarityClusterConfig,
	type SimilarityClusterConfig as ResolvedConfig,
} from "./config.js";
import { extractItems, sessionItemsFingerprint, selfSourceRef, siblingSourceRef, type SessionItems } from "./extract.js";
import {
	clusterItems,
	rankFindings,
	DETECTORS,
	type ClusterFinding,
	type Detector,
	type DetectorOutcome,
	type DetectorParams,
} from "./pipeline.js";

/** A proposal this analyzer embeds in its node; materialised by the framework. */
export const SimilarityClusterRawProposal = Type.Object({
	target_type: Type.String(),
	target_path: Type.Optional(Type.String()),
	title: Type.String(),
	summary: Type.String(),
	detail: Type.String(),
	evidence: Type.String(),
	confidence: Type.Number(),
	severity: Type.String(),
});

const ClusterMemberSchema = Type.Object({
	session_id: Type.String(),
	message_id: Type.String(),
	turn_ordinal: Type.Number(),
	normalized_hash: Type.String(),
	excerpt: Type.String(),
});

const PairwiseSimilaritySchema = Type.Object({
	i: Type.Number(),
	j: Type.Number(),
	similarity: Type.Number(),
});

const ClusterFindingSchema = Type.Object({
	detector: Type.Union([
		Type.Literal("tool_call"),
		Type.Literal("tool_result"),
		Type.Literal("user_prompt"),
	]),
	size: Type.Number(),
	avg_similarity: Type.Number(),
	exact: Type.Boolean(),
	members: Type.Array(ClusterMemberSchema),
	similarities: Type.Array(PairwiseSimilaritySchema),
});

/** The properties a similarity-cluster node carries in its `contentJson`. */
export const SIMILARITY_CLUSTER_PROPERTIES = Type.Object({
	session_id: Type.String(),
	/** "repo" when sibling sessions were pooled into this unit, "session" when clustering ran alone. */
	scope: Type.Union([Type.Literal("session"), Type.Literal("repo")]),
	sessions_scanned: Type.Number(),
	clusters: Type.Array(ClusterFindingSchema),
	cluster_count: Type.Number(),
	blind_count: Type.Number(),
	corpus_size: Type.Number(),
	comparisons: Type.Number(),
	improvement_proposals: Type.Array(SimilarityClusterRawProposal),
});
export type SimilarityClusterProperties = Static<typeof SIMILARITY_CLUSTER_PROPERTIES>;

export const SIMILARITY_CLUSTER_DEF: AnalyzerDef = {
	id: "similarity-cluster",
	label: "Similarity Clusters (deterministic)",
	description:
		"Deterministic near-miss text clustering over three domains — user prompts, normalised tool calls, and tool results — across sessions sharing a repo and within one session. Shingle-index candidate nomination, length-band pruning, LCS scoring, exact-hash equivalence classes plus non-transitive near-miss pairs. No LLM.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: SIMILARITY_CLUSTER_PROPERTIES,
};

export const SIMILARITY_CLUSTER_VERSION: AnalyzerVersion = {
	analyzerId: SIMILARITY_CLUSTER_DEF.id,
	// 1.0 (issue #145): the four-stage deterministic pipeline over all three
	// domains, cross-session pooling via the contrast mechanism (cwd-grouped,
	// source-set-committed), exact-class grouping, non-transitive pairs, blind
	// visibility, and recurrence-gated proposals.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/similarity-cluster/index.ts",
};

function resolveConfig(raw: unknown): ResolvedConfig {
	return (raw as ResolvedConfig) ?? DEFAULT_SIMILARITY_CLUSTER_CONFIG;
}

function detectorParams(cfg: ResolvedConfig, detector: Detector): DetectorParams {
	switch (detector) {
		case "tool_call":
			return {
				shingleWidth: cfg.shingleWidthToolCalls,
				threshold: cfg.thresholdToolCalls,
				nominateWith: cfg.nominateWithToolCalls,
				maxFreq: cfg.maxFreqToolCalls,
				minTokens: cfg.minTokensToolCalls,
			};
		case "tool_result":
			return {
				shingleWidth: cfg.shingleWidthResults,
				threshold: cfg.thresholdResults,
				nominateWith: cfg.nominateWithText,
				maxFreq: cfg.maxFreqText,
				minTokens: cfg.minTokensResults,
			};
		case "user_prompt":
			return {
				shingleWidth: cfg.shingleWidthPrompts,
				threshold: cfg.thresholdPrompts,
				nominateWith: cfg.nominateWithText,
				maxFreq: cfg.maxFreqText,
				minTokens: cfg.minTokensPrompts,
			};
	}
}

function detectorEnabled(cfg: ResolvedConfig, detector: Detector): boolean {
	switch (detector) {
		case "tool_call":
			return cfg.detectToolCalls;
		case "tool_result":
			return cfg.detectToolResults;
		case "user_prompt":
			return cfg.detectUserPrompts;
	}
}

function mergeOutcomes(outcomes: DetectorOutcome[]): DetectorOutcome {
	const merged: DetectorOutcome = { findings: [], blindCount: 0, corpusSize: 0, comparisons: 0 };
	for (const o of outcomes) {
		merged.findings.push(...o.findings);
		merged.blindCount += o.blindCount;
		merged.corpusSize += o.corpusSize;
		merged.comparisons += o.comparisons;
	}
	return merged;
}

function emptySessionItems(): SessionItems {
	return { prompts: [], toolCalls: [], toolResults: [] };
}

function mergeSessionItems(target: SessionItems, add: SessionItems): void {
	target.prompts.push(...add.prompts);
	target.toolCalls.push(...add.toolCalls);
	target.toolResults.push(...add.toolResults);
}

/** Verbatim opening of a user message, kept only long enough to quote in evidence. */
const PREVIEW_MAX = 200;

function collectPromptPreviews(messages: MessageRow[], sessionId: string, into: Map<string, string>): void {
	for (const m of messages) {
		if (m.role === "user" && m.content_text && m.content_text.trim().length > 0) {
			into.set(`${sessionId}:${m.id}`, m.content_text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_MAX));
		}
	}
}

/**
 * Is this repeated prompt a correction — the user re-teaching a rule the agent
 * should already know? Deliberately narrow marker list; anything unrecognised
 * stays a plain suggestion.
 */
const CORRECTION_MARKER_RE =
	/\b(don'?t|dont|never|stop|instead|wrong|quit|avoid|no longer)\b/i;

interface ProposalDraft {
	target_type: string;
	title: string;
	summary: string;
	detail: string;
	evidence: string;
	confidence: number;
	severity: string;
}

function formatSessionList(sessionIds: string[]): string {
	const shown = sessionIds.slice(0, 10);
	const rest = sessionIds.length - shown.length;
	return shown.join(", ") + (rest > 0 ? `, … (+${rest} more)` : "");
}

function buildProposal(
	finding: ClusterFinding,
	cfg: ResolvedConfig,
	promptPreviews: Map<string, string>,
): ProposalDraft | null {
	if (finding.size < cfg.minClusterSize) return null;
	const threshold = detectorParams(cfg, finding.detector).threshold;
	if (!finding.exact && finding.avg_similarity < 1 - threshold) return null;

	const sessionIds = [...new Set(finding.members.map((m) => m.session_id))].sort();
	const exemplar = finding.members[0]!.excerpt || finding.members[1]?.excerpt || "";

	let title: string;
	let summary: string;
	let detail: string;
	let targetType: string;
	let severity = "suggestion";

	switch (finding.detector) {
		case "tool_call": {
			targetType = "skill";
			title = `Repeated tool call pattern (${finding.size}×)`;
			summary =
				`The same ${finding.exact ? "exact" : "near-identical"} call shape occurred ${finding.size} times ` +
				`across ${sessionIds.length} session${sessionIds.length === 1 ? "" : "s"} — a de facto workflow that ` +
				`could be one skill invocation or alias.`;
			detail =
				finding.exact && finding.size >= 5
					? "Exactly the same call five or more times is not coincidence. Add a skill or alias for it; if it reads the same file every time, prefer a cached or background read pattern."
					: "Add a skill or alias covering this call shape so future sessions reach for one command instead of rediscovering it.";
			if (finding.exact && finding.size >= 5) severity = "correction";
			break;
		}
		case "tool_result": {
			targetType = "agents_md";
			title = `Same tool result fetched repeatedly (${finding.size}×)`;
			summary =
				`A ${finding.exact ? "byte-identical" : "near-identical"} tool result was produced ${finding.size} times ` +
				`across ${sessionIds.length} session${sessionIds.length === 1 ? "" : "s"} — the same context being re-read instead of remembered.`;
			detail =
				"Add a standing instruction pointing at the durable answer (a cached summary, a narrower read range, or a note in the project docs) so the agent stops paying to fetch the same body again.";
			break;
		}
		case "user_prompt": {
			targetType = "agents_md";
			const isCorrection = finding.members.some((m) => {
				const preview = promptPreviews.get(`${m.session_id}:${m.message_id}`);
				return preview ? CORRECTION_MARKER_RE.test(preview) : false;
			});
			title = `Repeated user ${isCorrection ? "correction" : "instruction"} (${finding.size}×)`;
			summary =
				`The user wrote ${finding.exact ? "the same" : "an almost identical"} prompt ${finding.size} times ` +
				`across ${sessionIds.length} session${sessionIds.length === 1 ? "" : "s"} — re-teaching something that belongs in a standing instruction or skill.`;
			detail = isCorrection
				? "A correction typed more than once is friction the steering artifacts can absorb: encode the rule verbatim in AGENTS.md or a skill so the agent stops needing the reminder."
				: "Recurring phrasing may indicate a missing capability or documentation gap; consider encoding the request as a skill.";
			if (isCorrection) severity = "correction";
			break;
		}
	}

	const evidenceParts = [
		`${finding.size} member(s) across ${sessionIds.length} session(s)`,
		`avg similarity ${finding.avg_similarity.toFixed(2)}${finding.exact ? " (exact)" : ""}`,
	];
	if (exemplar) evidenceParts.push(`e.g. "${exemplar.slice(0, PREVIEW_MAX)}"`);
	evidenceParts.push(`sessions: ${formatSessionList(sessionIds)}`);

	return {
		target_type: targetType,
		title,
		summary,
		detail,
		evidence: evidenceParts.join("; "),
		confidence: 0.6,
		severity,
	};
}

export const similarityClusterAnalyzer: Analyzer = {
	def: SIMILARITY_CLUSTER_DEF,
	version: SIMILARITY_CLUSTER_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: SIMILARITY_CLUSTER_DEF.id,
		configHash: computeConfigHash(DEFAULT_SIMILARITY_CLUSTER_CONFIG),
		configJson: DEFAULT_SIMILARITY_CLUSTER_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		if (ctx.messages.length === 0) return [];
		const cfg = resolveConfig(ctx.config);

		// Self fingerprint first: even a session with no sibling pools commits to
		// its own item content, so a later sync that changes its items re-identifies
		// the unit honestly.
		const selfItems = extractItems(ctx.sessionId, ctx.messages, cfg);
		const sources: SourceRef[] = [selfSourceRef(ctx.sessionId, sessionItemsFingerprint(selfItems))];

		// Sibling pool: sessions sharing this session's cwd (repo), deterministic
		// id order, capped. Same mechanism as cross-session contrast — raw
		// ingested messages, folded into identity by fingerprint.
		const siblingIds: string[] = [];
		const cwdRow = (await ctx.db.prepare("SELECT cwd FROM sessions WHERE id = ?").get(ctx.sessionId)) as
			| { cwd?: string }
			| undefined;
		const cwd = cwdRow?.cwd ?? "";
		if (cwd) {
			const rows = (await ctx.db
				.prepare("SELECT id FROM sessions WHERE cwd = ? AND id <> ? ORDER BY id ASC LIMIT ?")
				.all(cwd, ctx.sessionId, cfg.maxSessions)) as Array<{ id: string }>;
			for (const r of rows) {
				const sibMessages = (await ctx.db
					.prepare(
						"SELECT id, session_id, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, model, cost_usd, stop_reason, error_message " +
							"FROM messages WHERE session_id = ? ORDER BY rowid ASC",
					)
					.all(r.id)) as MessageRow[];
				const sibItems = extractItems(r.id, sibMessages, cfg);
				sources.push(siblingSourceRef(r.id, sessionItemsFingerprint(sibItems)));
				siblingIds.push(r.id);
			}
		}

		return [
			{
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
				meta: { siblingIds },
			},
		];
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const cfg = resolveConfig(ctx.config.configJson);

		const pooled = emptySessionItems();
		const promptPreviews = new Map<string, string>();

		const selfMessages = await ctx.getSessionMessages(ctx.sessionId);
		mergeSessionItems(pooled, extractItems(ctx.sessionId, selfMessages, cfg));
		collectPromptPreviews(selfMessages, ctx.sessionId, promptPreviews);

		const siblingIds = ((unit.meta?.["siblingIds"] as string[] | undefined) ?? []).filter(
			(id): id is string => typeof id === "string",
		);
		for (const sid of siblingIds) {
			const messages = await ctx.getSessionMessages(sid);
			mergeSessionItems(pooled, extractItems(sid, messages, cfg));
			collectPromptPreviews(messages, sid, promptPreviews);
		}

		// One pipeline pass per enabled domain.
		const outcomes: DetectorOutcome[] = [];
		for (const detector of DETECTORS) {
			if (!detectorEnabled(cfg, detector)) continue;
			const domainItems =
				detector === "tool_call" ? pooled.toolCalls : detector === "tool_result" ? pooled.toolResults : pooled.prompts;
			outcomes.push(clusterItems(domainItems, detectorParams(cfg, detector), detector));
		}
		const outcome = mergeOutcomes(outcomes);

		const clusters = rankFindings(outcome.findings, cfg.topClusters);
		const proposals: Array<Static<typeof SimilarityClusterRawProposal>> = [];
		for (const finding of clusters) {
			const draft = buildProposal(finding, cfg, promptPreviews);
			if (draft) proposals.push(draft);
		}

		const properties: SimilarityClusterProperties = {
			session_id: ctx.sessionId,
			scope: siblingIds.length > 0 ? "repo" : "session",
			sessions_scanned: 1 + siblingIds.length,
			clusters,
			cluster_count: clusters.length,
			blind_count: outcome.blindCount,
			corpus_size: outcome.corpusSize,
			comparisons: outcome.comparisons,
			improvement_proposals: proposals,
		};

		// Anchors: the analysed session, every member message we name, and every
		// OTHER session whose items appear in a reported cluster — the traceable
		// walk back to exactly the conversations that justify each finding.
		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
		];
		let ordinal = 1;
		const anchoredMessages = new Set<string>();
		for (const c of clusters) {
			for (const m of c.members) {
				if (!anchoredMessages.has(m.message_id) && anchoredMessages.size < 8) {
					anchoredMessages.add(m.message_id);
					edges.push({ toRefKind: REF_KINDS.MESSAGE, toRefId: m.message_id, edgeKind: EDGE_KINDS.ANCHORS, ordinal: ordinal++ });
				}
			}
		}
		const memberSessions = new Set(clusters.flatMap((c) => c.members.map((m) => m.session_id)));
		for (const sid of [...memberSessions].sort()) {
			if (sid !== ctx.sessionId) {
				edges.push({ toRefKind: REF_KINDS.SESSION, toRefId: sid, edgeKind: EDGE_KINDS.ANCHORS, ordinal: ordinal++ });
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
