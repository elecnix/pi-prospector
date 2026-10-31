/**
 * repo-identity — the repository a session belongs to, as one canonical key.
 *
 * Concentration metrics ("49 to 82% of sessions are in one repository") need one
 * key per repository. The host records only the working directory, so one
 * repository shows up as many directories (one per worktree) and, in the host's
 * own project field, as several spellings. This analyzer reads the working
 * directory and writes the key (see `detect.ts` for the rule).
 *
 * One session-anchored metric node per session, with the key, the worktree, and
 * a placement that says why a session has no key (temporary directory, outside
 * every repository root, or no directory recorded). Deterministic, no LLM, and
 * it proposes nothing.
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
import { computeConfigHash, shortHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { Type, type Static } from "typebox";
import { getSessionCwd } from "../session-overview/cross-session.js";
import { DEFAULT_REPO_IDENTITY_CONFIG, type RepoIdentityConfig } from "./config.js";
import { repoIdentityOf } from "./detect.js";

/** The properties a repo-identity node carries in its `contentJson`. */
export const REPO_IDENTITY_PROPERTIES = Type.Object({
	session_id: Type.String(),
	repo_key: Type.Union([Type.String(), Type.Null()]),
	placement: Type.Union([Type.Literal("repo"), Type.Literal("temp"), Type.Literal("unplaced"), Type.Literal("unknown")]),
	checkout: Type.Union([Type.String(), Type.Null()]),
	root: Type.Union([Type.String(), Type.Null()]),
});
export type RepoIdentityProperties = Static<typeof REPO_IDENTITY_PROPERTIES>;

export const REPO_IDENTITY_DEF: AnalyzerDef = {
	id: "repo-identity",
	label: "Repository Identity (deterministic)",
	description:
		"Records the repository a session belongs to as one canonical key, read from the working directory: the directory right below a repository root, lowercased. Worktrees of one repository share a key. A session in a temporary directory, outside every root, or with no directory recorded gets no key and a placement that says which. One session-anchored metric node per session. Deterministic, no LLM; it proposes nothing.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: REPO_IDENTITY_PROPERTIES,
};

export const REPO_IDENTITY_VERSION: AnalyzerVersion = {
	analyzerId: REPO_IDENTITY_DEF.id,
	// 1.0: repository key from the working directory under a repository root.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/repo-identity/index.ts",
};

function resolveConfig(raw: unknown): RepoIdentityConfig {
	return { ...DEFAULT_REPO_IDENTITY_CONFIG, ...((raw as Partial<RepoIdentityConfig> | null | undefined) ?? {}) };
}

export const repoIdentityAnalyzer: Analyzer = {
	def: REPO_IDENTITY_DEF,
	version: REPO_IDENTITY_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: REPO_IDENTITY_DEF.id,
		configHash: computeConfigHash(DEFAULT_REPO_IDENTITY_CONFIG),
		configJson: DEFAULT_REPO_IDENTITY_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		// The working directory is the whole input, so it enters the source set by
		// hash: a session whose recorded directory changes becomes a new unit.
		const cwd = await getSessionCwd(ctx.db, ctx.sessionId);
		const sources: SourceRef[] = [{ kind: "session", id: `${ctx.sessionId}#cwd=${shortHash(cwd)}` }];
		return [
			{
				sources,
				sourceSetHash: shortHash(`repo-identity(${ctx.sessionId}|${shortHash(cwd)})`),
				anchorKind: "session" as const,
				anchorRef: ctx.sessionId,
				meta: { cwd } as unknown as Record<string, unknown>,
			},
		];
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const cwd = (unit.meta?.["cwd"] as string | undefined) ?? (await getSessionCwd(ctx.db, ctx.sessionId));
		const properties: RepoIdentityProperties = { session_id: ctx.sessionId, ...repoIdentityOf(cwd, config) };
		return {
			nodeKind: "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			edges: [{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 }],
		};
	},
};
