/**
 * pr-opened — the pull request a session opened, recorded on the session.
 *
 * Every other analyzer reads a session for what went wrong or what it cost.
 * None answers a plainer question a reader asks first: what did this session
 * actually produce? When the session opened a pull request, the answer is a URL
 * and a title a person can open, and both are already in the transcript — the
 * command that created it carried the title, and the forge's own answer carried
 * the URL.
 *
 * This analyzer records that pair against the session: one session-anchored
 * metric node per pull request the session opened, carrying the URL, the
 * repository, the number, and the title, with `anchors` edges to the call and
 * the result it was read from. Detection rules, and what separates opening a
 * pull request from reading one, are documented in `detect.ts`; **this analyzer
 * proposes nothing**. It is a label on a session, in the shape `session-ending`
 * established: a measurement emitted, stored, and verifiable, with its uses
 * layered on top later.
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
import { DEFAULT_PR_OPENED_CONFIG, type PrOpenedConfig } from "./config.js";
import {
	findOpenedPullRequests,
	type OpenedPullRequestWithEvidence,
} from "./detect.js";

/** The properties a pr-opened node carries for one pull request. */
export const PULL_REQUEST_PROPERTIES = Type.Object({
	url: Type.String(),
	host: Type.String(),
	owner: Type.String(),
	repo: Type.String(),
	number: Type.Number(),
	/** The title the session gave it, or null when the creation call did not state one. */
	title: Type.Union([Type.String(), Type.Null()]),
	/** Which kind of call opened it: a shell `gh pr create`, or a forge tool. */
	via: Type.Union([Type.Literal("gh_pr_create"), Type.Literal("tool")]),
	call_message_id: Type.String(),
	result_message_id: Type.String(),
});

/** The properties a pr-opened node carries in its `contentJson`. */
export const PR_OPENED_PROPERTIES = Type.Object({
	session_id: Type.String(),
	pull_request: PULL_REQUEST_PROPERTIES,
});
export type PrOpenedProperties = Static<typeof PR_OPENED_PROPERTIES>;

export const PR_OPENED_DEF: AnalyzerDef = {
	id: "pr-opened",
	label: "Pull Request Opened (deterministic)",
	description:
		"Records the pull request a session opened, as the URL and title the transcript carries: the creation call's own arguments for the title, the forge's answer for the URL. One session-anchored metric node per pull request, anchored to the call and the result it was read from. Deterministic, no LLM; it proposes nothing.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: PR_OPENED_PROPERTIES,
};

export const PR_OPENED_VERSION: AnalyzerVersion = {
	analyzerId: PR_OPENED_DEF.id,
	// 1.0: shell `gh pr create` and hosted-forge creation tools, with the URL
	// taken from the forge's own answer.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/pr-opened/index.ts",
};

function resolveConfig(raw: unknown): PrOpenedConfig {
	return {
		...DEFAULT_PR_OPENED_CONFIG,
		...((raw as Partial<PrOpenedConfig> | null | undefined) ?? {}),
	};
}

/**
 * Fingerprint of what the detection reads: every message's id, role, tool calls,
 * and tool results, plus a hash of each text. Hashing the texts themselves makes
 * a re-sync that backfills a result re-identify the unit, so the node is
 * recomputed against what the forge actually said.
 */
function prFingerprint(messages: readonly MessageRow[]): string {
	const lines: string[] = [];
	for (const m of messages) {
		lines.push(
			[
				m.id,
				m.role,
				m.tool_calls ? shortHash(m.tool_calls) : "",
				m.tool_results ? shortHash(m.tool_results) : "",
				m.content_text ? shortHash(m.content_text) : "",
			].join(":"),
		);
	}
	return shortHash(lines.join("\n"));
}

export const prOpenedAnalyzer: Analyzer = {
	def: PR_OPENED_DEF,
	version: PR_OPENED_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: PR_OPENED_DEF.id,
		configHash: computeConfigHash(DEFAULT_PR_OPENED_CONFIG),
		configJson: DEFAULT_PR_OPENED_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		if (ctx.messages.length === 0) return [];
		const config = resolveConfig(ctx.config.configJson);
		const found = findOpenedPullRequests(ctx.messages, config);
		const fingerprint = prFingerprint(ctx.messages);

		// One unit per pull request, so a session that opens a second one adds a
		// node rather than rewriting the node its first pull request earned.
		return found.map((entry) => {
			const sources: SourceRef[] = [
				{
					kind: "session",
					// The session source carries the fingerprint, and the pull request's
					// own evidence hash rides alongside the URL, so the source set changes
					// exactly when what this node records about it changes.
					id: `${ctx.sessionId}#pr=${entry.pull_request.url}@${entry.evidence_hash}`,
				},
			];
			return {
				sources,
				sourceSetHash: shortHash(
					`pr-opened(${ctx.sessionId}|${entry.pull_request.url}|${entry.evidence_hash}|${fingerprint})`,
				),
				anchorKind: "session" as const,
				anchorRef: ctx.sessionId,
				meta: { url: entry.pull_request.url, evidence_hash: entry.evidence_hash } as unknown as Record<string, unknown>,
			};
		});
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		const url = unit.meta?.["url"] as string | undefined;
		const evidenceHash = unit.meta?.["evidence_hash"] as string | undefined;
		const entry: OpenedPullRequestWithEvidence | undefined = findOpenedPullRequests(messages, config).find(
			(f) => f.pull_request.url === url && (evidenceHash === undefined || f.evidence_hash === evidenceHash),
		);
		if (!entry) {
			throw new Error(
				`pr-opened unit planned but its pull request is no longer in the transcript (session ${ctx.sessionId}, ${url ?? "no url"})`,
			);
		}

		const properties: PrOpenedProperties = {
			session_id: ctx.sessionId,
			pull_request: entry.pull_request,
		};

		// Anchor the session, and the two rows the record was read from, so the
		// node walks back to the exact call and result behind it.
		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
			{
				toRefKind: REF_KINDS.MESSAGE,
				toRefId: entry.pull_request.call_message_id,
				edgeKind: EDGE_KINDS.ANCHORS,
				ordinal: 1,
			},
			{
				toRefKind: REF_KINDS.MESSAGE,
				toRefId: entry.pull_request.result_message_id,
				edgeKind: EDGE_KINDS.ANCHORS,
				ordinal: 2,
			},
		];

		return {
			nodeKind: "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			edges,
		};
	},
};
