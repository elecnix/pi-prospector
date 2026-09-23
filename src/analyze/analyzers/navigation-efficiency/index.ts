/**
 * navigation-efficiency — deterministic structural-navigation anti-patterns
 * (issue #254).
 *
 * Reconstructs the *structural* dimension of a session's file navigation —
 * directory ↦ file ↦ block depth, not just the flat list of paths — and flags
 * the four localization inefficiencies Graphectory (Chen et al., 2026,
 * arXiv:2512.02393) formalises as mismatches between temporal and structural
 * order: **Scroll**, **ZoomOut**, **OverlyDeepZoom**, and **RepeatedView**.
 * Every read in such a session succeeds and none repeats consecutively, so
 * none of it reaches the per-turn friction score or `tool-trajectory`'s
 * stuck-loop; `files-in-play` sees the flat set of files, not the shape of the
 * path between them.
 *
 * The paper's live monitor intervenes mid-run; that half is out of scope
 * (DESIGN.md §5). This analyzer observes a finished session. Detection is
 * fully deterministic (no LLM); the heuristics are documented in `detect.ts`.
 * One node per session: metric by default, carrying the paper's structural
 * metrics (SEC, SB) and every detected episode; when a pattern's episodes
 * reach `proposalMinEpisodes`, the node carries `improvement_proposals` and is
 * emitted as kind `proposal`, following the files-in-play convention for
 * deterministic analyzers — the framework materialises those into the
 * proposal store.
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
	DEFAULT_NAVIGATION_EFFICIENCY_CONFIG,
	type NavigationEfficiencyConfig,
} from "./config.js";
import {
	extractNavigation,
	scanNavigation,
	NavEpisode,
	type NavPattern,
	type NavigationScan,
} from "./detect.js";

/** A proposal this analyzer embeds in its node; materialised by the framework. */
export const NavigationEfficiencyRawProposal = Type.Object({
	target_type: Type.String(),
	target_path: Type.Optional(Type.String()),
	title: Type.String(),
	summary: Type.String(),
	detail: Type.String(),
	evidence: Type.String(),
	confidence: Type.Number(),
	severity: Type.String(),
});
export type NavigationEfficiencyRawProposal = Static<typeof NavigationEfficiencyRawProposal>;

const PatternCounts = Type.Object({
	scroll: Type.Integer(),
	zoom_out: Type.Integer(),
	overly_deep_zoom: Type.Integer(),
	repeated_view: Type.Integer(),
});

/** The properties a navigation-efficiency node carries in its `contentJson`. */
export const NAVIGATION_EFFICIENCY_PROPERTIES = Type.Object({
	session_id: Type.String(),
	/** Navigation views extracted (directory, file, and block views). */
	view_count: Type.Integer(),
	/** Edits of files seen in the same stream. */
	edit_count: Type.Integer(),
	/** Distinct structural regions viewed. */
	regions_viewed: Type.Integer(),
	/** Structural-edge count: viewed regions with a viewed ancestor. */
	structural_edge_count: Type.Integer(),
	/** Structural breadth: most viewed children under one viewed region. */
	structural_breadth: Type.Integer(),
	/** Deepest structural level viewed. */
	max_depth: Type.Integer(),
	/** Episodes detected per pattern, before the `maxEpisodes` cap. */
	pattern_counts: PatternCounts,
	/** Detected episodes, at most `maxEpisodes` per pattern. */
	episodes: Type.Array(NavEpisode),
	improvement_proposals: Type.Array(NavigationEfficiencyRawProposal),
});
export type NavigationEfficiencyProperties = Static<typeof NAVIGATION_EFFICIENCY_PROPERTIES>;

export const NAVIGATION_EFFICIENCY_DEF: AnalyzerDef = {
	id: "navigation-efficiency",
	label: "Navigation Efficiency (deterministic)",
	description:
		"Reconstructs the structural depth (directory ↦ file ↦ block) of each session's file navigation and detects Graphectory's localization anti-patterns — Scroll (overlapping slices of one file), ZoomOut (deep → shallow → deep with no edit), OverlyDeepZoom (long view-only runs on a path never edited), and RepeatedView (returning to a region after leaving it) — plus the structural-edge count and structural breadth. No LLM.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: NAVIGATION_EFFICIENCY_PROPERTIES,
};

export const NAVIGATION_EFFICIENCY_VERSION: AnalyzerVersion = {
	analyzerId: NAVIGATION_EFFICIENCY_DEF.id,
	// 1.0 (issue #254): path-depth model over read/ls/find/glob/grep and bash
	// navigation, the four structural anti-pattern detectors, SEC/SB metrics,
	// and a per-pattern recurrence-gated proposal.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/navigation-efficiency/index.ts",
};

function resolveConfig(raw: unknown): NavigationEfficiencyConfig {
	return (raw as NavigationEfficiencyConfig) ?? DEFAULT_NAVIGATION_EFFICIENCY_CONFIG;
}

/**
 * Fingerprint of everything this analyzer reads: the ordered navigation
 * stream. Config is deliberately NOT folded in — it is the framework's
 * config-fingerprint axis, so a threshold change marks prior nodes stale for
 * the `config` reason with lineage preserved rather than re-identifying them
 * as missing.
 */
function navigationFingerprint(messages: readonly MessageRow[]): string {
	const actions = extractNavigation(messages);
	const lines = actions.map((a) => `${a.ordinal}:${a.kind}:${a.level}:${a.path}:${a.start}-${a.end}:${a.ok ? 1 : 0}`);
	lines.push(`n:${actions.length}`);
	return shortHash(lines.join("\n"));
}

/** The remedy each pattern points at — a standing instruction; nothing to install. */
const REMEDIES: Record<NavPattern, { title: string; noun: string; detail: string }> = {
	scroll: {
		title: "Overlapping slices of one file instead of reading the enclosing unit",
		noun: "scroll",
		detail:
			"Add a standing instruction to locate the enclosing function or class first (`rg -n` for its definition) and read it in one slice sized to its boundaries, rather than paging overlapping line ranges around the point of interest.",
	},
	zoom_out: {
		title: "Backing out of a deep branch and descending again without acting",
		noun: "zoom-out",
		detail:
			"Add a standing instruction to localize with a repository-wide search (`rg -n <symbol>`) before descending into a subdirectory, so the agent does not dive into the wrong branch, climb back out, and dive again.",
	},
	overly_deep_zoom: {
		title: "Long view-only runs on paths the agent never patched",
		noun: "overly-deep zoom",
		detail:
			"Add a standing instruction to state a hypothesis about where the change belongs after a few reads of one path, and move on when that path is ruled out, instead of continuing to read it without ever converging on an edit.",
	},
	repeated_view: {
		title: "Returning to regions already viewed after leaving them",
		noun: "repeated view",
		detail:
			"Add a standing instruction to record what each read established (the relevant lines, the symbol's location) before moving on, so localization does not require going back to regions already read.",
	},
};

const PATTERNS: readonly NavPattern[] = ["scroll", "zoom_out", "overly_deep_zoom", "repeated_view"];

function describeEpisode(e: NavEpisode): string {
	if (e.pattern === "zoom_out") return `${e.path} (depth ${e.depths.join("→")})`;
	return `${e.path} (${e.views} views)`;
}

/**
 * One proposal per pattern whose episodes reach `proposalMinEpisodes` — a
 * single scroll or revisit is noise, and each pattern has its own remedy, so
 * they are not merged into one.
 */
function buildProposals(scan: NavigationScan, config: NavigationEfficiencyConfig): NavigationEfficiencyRawProposal[] {
	const out: NavigationEfficiencyRawProposal[] = [];
	for (const pattern of PATTERNS) {
		const episodes = scan.episodes.filter((e) => e.pattern === pattern);
		if (episodes.length < config.proposalMinEpisodes) continue;
		const remedy = REMEDIES[pattern];
		const n = episodes.length;
		out.push({
			target_type: "agents_md",
			title: remedy.title,
			summary: `The agent's navigation showed ${n} ${remedy.noun} episode${n === 1 ? "" : "s"} — successful reads that each looked fine alone but, in sequence, spent turns on regions it had already seen or had no use for.`,
			detail: remedy.detail,
			evidence: `${n} ${remedy.noun} episode${n === 1 ? "" : "s"}: ${episodes.slice(0, 3).map(describeEpisode).join("; ")}. Structural-edge count ${scan.metrics.sec}, structural breadth ${scan.metrics.sb}, over ${scan.viewCount} views.`,
			confidence: 0.5,
			severity: "waste",
		});
	}
	return out;
}

export const navigationEfficiencyAnalyzer: Analyzer = {
	def: NAVIGATION_EFFICIENCY_DEF,
	version: NAVIGATION_EFFICIENCY_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: NAVIGATION_EFFICIENCY_DEF.id,
		configHash: computeConfigHash(DEFAULT_NAVIGATION_EFFICIENCY_CONFIG),
		configJson: DEFAULT_NAVIGATION_EFFICIENCY_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		// No conversation → nothing to navigate. A session with messages but no
		// navigation still gets a (clean) node.
		if (ctx.messages.length === 0) return [];
		const fingerprint = navigationFingerprint(ctx.messages);
		const sources: SourceRef[] = [{ kind: "session", id: `${ctx.sessionId}#navigation=${fingerprint}` }];
		return [
			{
				sources,
				sourceSetHash: shortHash(`navigation-efficiency(${ctx.sessionId}|${fingerprint})`),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
			},
		];
	},

	async analyze(_unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		const scan = scanNavigation(messages, config);
		const proposals = buildProposals(scan, config);

		const counts = { scroll: 0, zoom_out: 0, overly_deep_zoom: 0, repeated_view: 0 };
		for (const e of scan.episodes) counts[e.pattern]++;
		const kept = PATTERNS.flatMap((p) => scan.episodes.filter((e) => e.pattern === p).slice(0, config.maxEpisodes));

		const properties: NavigationEfficiencyProperties = {
			session_id: ctx.sessionId,
			view_count: scan.viewCount,
			edit_count: scan.editCount,
			regions_viewed: scan.metrics.regions,
			structural_edge_count: scan.metrics.sec,
			structural_breadth: scan.metrics.sb,
			max_depth: scan.metrics.maxDepth,
			pattern_counts: counts,
			episodes: kept,
			improvement_proposals: proposals,
		};

		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
		];
		// Anchor to the messages that issued the episodes' views, so each finding
		// walks back to the exact turns where the navigation went sideways.
		const anchored = new Set<string>();
		for (const e of kept) for (const id of e.messageIds) anchored.add(id);
		let ordinal = 1;
		for (const messageId of [...anchored].slice(0, 12)) {
			edges.push({ toRefKind: REF_KINDS.MESSAGE, toRefId: messageId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: ordinal++ });
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
