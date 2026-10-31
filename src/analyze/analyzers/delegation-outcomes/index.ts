/**
 * delegation-outcomes — how a session's hand-offs to child agents ended.
 *
 * The corpus counts child sessions, but not how the delegation went: how many
 * children finished, failed, were stopped, were revived, or were never answered,
 * and how much of the work moved to children at all. One session-anchored metric
 * node per session lists each delegation call with its outcome (read from the
 * host's records; see `detect.ts` for the order) and per-outcome counts, plus the
 * child sessions that name this one as their parent and the messages they contain.
 * A session that delegated nothing gets zero counts, so a rate keeps its
 * denominator. Deterministic, no LLM, and it proposes nothing.
 *
 * `completed` means the host did not report a failure. It never says the child's work
 * was right.
 */

import type {
	Analyzer,
	AnalyzerDef,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	AnalysisResult,
	AnalysisUnit,
	BackgroundTaskRow,
	MessageRow,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeConfigHash, shortHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { Type, type Static } from "typebox";
import { getBackgroundTasksForSession, getChildSessionStats } from "../../../db/queries.js";
import { DEFAULT_DELEGATION_OUTCOMES_CONFIG, type DelegationOutcomesConfig } from "./config.js";
import { scanDelegations } from "./detect.js";

const OUTCOME = Type.Union([
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("killed"),
	Type.Literal("revived"),
	Type.Literal("unanswered"),
	Type.Literal("other"),
]);

export const DELEGATION_EVENT = Type.Object({
	tool: Type.String(),
	agent: Type.Union([Type.String(), Type.Null()]),
	outcome: OUTCOME,
	background: Type.Boolean(),
	call_message_id: Type.String(),
});

/** The properties a delegation-outcomes node carries in its `contentJson`. */
export const DELEGATION_OUTCOMES_PROPERTIES = Type.Object({
	session_id: Type.String(),
	call_count: Type.Number(),
	counts: Type.Object({
		completed: Type.Number(),
		failed: Type.Number(),
		killed: Type.Number(),
		revived: Type.Number(),
		unanswered: Type.Number(),
		other: Type.Number(),
	}),
	events: Type.Array(DELEGATION_EVENT),
	tool_call_count: Type.Number(),
	child_session_count: Type.Number(),
	child_message_count: Type.Number(),
	own_message_count: Type.Number(),
});
export type DelegationOutcomesProperties = Static<typeof DELEGATION_OUTCOMES_PROPERTIES>;

export const DELEGATION_OUTCOMES_DEF: AnalyzerDef = {
	id: "delegation-outcomes",
	label: "Delegation Outcomes (deterministic)",
	description:
		"Records how a session's hand-offs to child agents ended: each delegation call with its outcome (completed, failed, killed, revived, unanswered), read from the host's background-task records, error flags, and orchestration classification, plus per-outcome counts, and the child sessions that name this session as their parent with the messages they contain. A session that delegated nothing gets zero counts. Completed means the host reported no failure, not that the work was right. Deterministic, no LLM; it proposes nothing.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: DELEGATION_OUTCOMES_PROPERTIES,
};

export const DELEGATION_OUTCOMES_VERSION: AnalyzerVersion = {
	analyzerId: DELEGATION_OUTCOMES_DEF.id,
	// 1.0: delegation call outcomes and the parent's share of work moved to children.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/delegation-outcomes/index.ts",
};

function resolveConfig(raw: unknown): DelegationOutcomesConfig {
	return { ...DEFAULT_DELEGATION_OUTCOMES_CONFIG, ...((raw as Partial<DelegationOutcomesConfig> | null | undefined) ?? {}) };
}

/**
 * Fingerprint of what the scan reads: each message's id, role, calls, and
 * results, the background completions, and the child-session totals. A
 * completion or a new child session re-identifies the unit, because the node's
 * content would otherwise change under an unchanged recipe.
 */
function delegationFingerprint(
	messages: readonly MessageRow[],
	tasks: readonly BackgroundTaskRow[],
	children: { child_session_count: number; child_message_count: number; own_message_count: number },
): string {
	const lines = messages.map((m) =>
		[m.id, m.role, m.tool_calls ? shortHash(m.tool_calls) : "", m.tool_results ? shortHash(m.tool_results) : ""].join(":"),
	);
	const done = tasks.map((t) => `${t.tool_use_id}:${t.completed_at}:${t.status ?? ""}`).sort();
	return shortHash([...lines, ...done, JSON.stringify(children)].join("\n"));
}

export const delegationOutcomesAnalyzer: Analyzer = {
	def: DELEGATION_OUTCOMES_DEF,
	version: DELEGATION_OUTCOMES_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: DELEGATION_OUTCOMES_DEF.id,
		configHash: computeConfigHash(DEFAULT_DELEGATION_OUTCOMES_CONFIG),
		configJson: DEFAULT_DELEGATION_OUTCOMES_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		if (ctx.messages.length === 0) return [];
		const tasks = await getBackgroundTasksForSession(ctx.db, ctx.sessionId);
		const children = await getChildSessionStats(ctx.db, ctx.sessionId);
		const sources: SourceRef[] = [{ kind: "session", id: ctx.sessionId }];
		return [
			{
				sources,
				sourceSetHash: shortHash(`delegation-outcomes(${ctx.sessionId}|${delegationFingerprint(ctx.messages, tasks, children)})`),
				anchorKind: "session" as const,
				anchorRef: ctx.sessionId,
			},
		];
	},

	async analyze(_unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		const scan = scanDelegations(messages, await ctx.getBackgroundTasks(ctx.sessionId), config);
		const children = await getChildSessionStats(ctx.db, ctx.sessionId);

		const properties: DelegationOutcomesProperties = {
			session_id: ctx.sessionId,
			call_count: scan.call_count,
			counts: scan.counts,
			events: scan.events,
			tool_call_count: scan.tool_call_count,
			...children,
		};

		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
			...[...new Set(scan.events.map((e) => e.call_message_id))].map((id, i) => ({
				toRefKind: REF_KINDS.MESSAGE,
				toRefId: id,
				edgeKind: EDGE_KINDS.ANCHORS,
				ordinal: i + 1,
			})),
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
