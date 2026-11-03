/**
 * repo-identity — the repository a session worked in, as one canonical key.
 *
 * Concentration metrics ("49 to 82% of sessions are in one repository") need one
 * key per repository. The host records only the working directory, which says
 * little: worktrees are named for branches and folder layouts are one person's
 * habit. This analyzer reads the git commands the session ran instead, and the
 * forge address they touched (see `detect.ts` for the hints and their order),
 * scoped by the session's working directory.
 *
 * One session-anchored metric node per session, with the key, the basis of the
 * hint that decided it, how many hints supported it, how many other addresses
 * competed, and the name of the working directory. A session with no hint has no
 * key and says so. Deterministic, no LLM, and it proposes nothing.
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
import { getSessionCwd } from "../session-overview/cross-session.js";
import { DEFAULT_REPO_IDENTITY_CONFIG, type RepoIdentityConfig } from "./config.js";
import { chooseRepo, findRepoHints } from "./detect.js";

/** The properties a repo-identity node carries in its `contentJson`. */
export const REPO_IDENTITY_PROPERTIES = Type.Object({
	session_id: Type.String(),
	repo_key: Type.Union([Type.String(), Type.Null()]),
	basis: Type.Union([
		Type.Literal("remote_output"),
		Type.Literal("pr_url"),
		Type.Literal("gh_repo_flag"),
		Type.Literal("command_url"),
		Type.Literal("none"),
	]),
	hint_count: Type.Number(),
	candidate_count: Type.Number(),
	directory: Type.Union([Type.String(), Type.Null()]),
	evidence_message_id: Type.Union([Type.String(), Type.Null()]),
});
export type RepoIdentityProperties = Static<typeof REPO_IDENTITY_PROPERTIES>;

export const REPO_IDENTITY_DEF: AnalyzerDef = {
	id: "repo-identity",
	label: "Repository Identity (deterministic)",
	description:
		"Records the repository a session worked in as one canonical key, `host/owner/name`, read from the forge address its own git commands touched: a remote printed by git, a pull request URL printed by gh, or a --repo flag, scoped by the session's working directory. The node says which hint decided the key and how many supported it. A session with no hint has a null key. One session-anchored metric node per session. Deterministic, no LLM; it proposes nothing.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: REPO_IDENTITY_PROPERTIES,
};

export const REPO_IDENTITY_VERSION: AnalyzerVersion = {
	analyzerId: REPO_IDENTITY_DEF.id,
	// 1.0: repository key from the forge address in the session's git commands.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/repo-identity/index.ts",
};

function resolveConfig(raw: unknown): RepoIdentityConfig {
	return { ...DEFAULT_REPO_IDENTITY_CONFIG, ...((raw as Partial<RepoIdentityConfig> | null | undefined) ?? {}) };
}

/** Fingerprint of what the hints read: ids, roles, calls, results, and result texts. */
function hintFingerprint(messages: readonly MessageRow[]): string {
	return shortHash(
		messages
			.map((m) =>
				[
					m.id,
					m.role,
					m.tool_calls ? shortHash(m.tool_calls) : "",
					m.tool_results ? shortHash(m.tool_results) : "",
					m.content_text ? shortHash(m.content_text) : "",
				].join(":"),
			)
			.join("\n"),
	);
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
		if (ctx.messages.length === 0) return [];
		// The working directory scopes the hints, so it enters the source set by hash.
		const cwd = await getSessionCwd(ctx.db, ctx.sessionId);
		const sources: SourceRef[] = [{ kind: "session", id: `${ctx.sessionId}#cwd=${shortHash(cwd)}` }];
		return [
			{
				sources,
				sourceSetHash: shortHash(`repo-identity(${ctx.sessionId}|${shortHash(cwd)}|${hintFingerprint(ctx.messages)})`),
				anchorKind: "session" as const,
				anchorRef: ctx.sessionId,
				meta: { cwd } as unknown as Record<string, unknown>,
			},
		];
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const cwd = (unit.meta?.["cwd"] as string | undefined) ?? (await getSessionCwd(ctx.db, ctx.sessionId));
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		const identity = chooseRepo(findRepoHints(messages, cwd, config), cwd);
		const properties: RepoIdentityProperties = { session_id: ctx.sessionId, ...identity };
		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
		];
		if (identity.evidence_message_id) {
			edges.push({ toRefKind: REF_KINDS.MESSAGE, toRefId: identity.evidence_message_id, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 1 });
		}
		return {
			nodeKind: "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			edges,
		};
	},
};
