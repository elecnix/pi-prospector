/**
 * session-delivery — what a session moved toward the remote.
 *
 * Whether a session produced a commit, a push, or a merged pull request is the
 * plainest thing a reader asks of it, and no node says. One session-anchored
 * metric node per session lists each delivery event (commit, push, pull request
 * merge) with its time and whether it succeeded, plus per-kind counts, anchored
 * to the session and to each call. A session with no event gets an empty list,
 * so a monthly rate keeps its denominator.
 *
 * This is a delivery record, not an outcome label. A commit says the session
 * produced something, never that the work was right. Opening a pull request is
 * `pr-opened`'s record, and a reader joins the two. Deterministic, no LLM, and
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
	MessageRow,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeConfigHash, shortHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { Type, type Static } from "typebox";
import { DEFAULT_SESSION_DELIVERY_CONFIG, type SessionDeliveryConfig } from "./config.js";
import { findDeliveryEvents } from "./detect.js";

const KIND = Type.Union([Type.Literal("commit"), Type.Literal("push"), Type.Literal("pr_merge")]);

export const DELIVERY_EVENT = Type.Object({
	kind: KIND,
	succeeded: Type.Boolean(),
	at: Type.Union([Type.String(), Type.Null()]),
	call_message_id: Type.String(),
	result_message_id: Type.Union([Type.String(), Type.Null()]),
});

const KIND_COUNTS = Type.Object({ attempted: Type.Number(), succeeded: Type.Number() });

/** The properties a session-delivery node carries in its `contentJson`. */
export const SESSION_DELIVERY_PROPERTIES = Type.Object({
	session_id: Type.String(),
	events: Type.Array(DELIVERY_EVENT),
	commit: KIND_COUNTS,
	push: KIND_COUNTS,
	pr_merge: KIND_COUNTS,
	/** Whether any event succeeded. */
	delivered: Type.Boolean(),
});
export type SessionDeliveryProperties = Static<typeof SESSION_DELIVERY_PROPERTIES>;

export const SESSION_DELIVERY_DEF: AnalyzerDef = {
	id: "session-delivery",
	label: "Session Delivery (deterministic)",
	description:
		"Records what a session moved toward the remote: each commit, push, and pull request merge the shell ran, with its time and whether it succeeded, and per-kind counts. A success the host reported is checked against the result text, since git can refuse with exit 0 and a pipe hides the status. A session with no event gets an empty list. A delivery record, not an outcome label. Deterministic, no LLM; it proposes nothing.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: SESSION_DELIVERY_PROPERTIES,
};

export const SESSION_DELIVERY_VERSION: AnalyzerVersion = {
	analyzerId: SESSION_DELIVERY_DEF.id,
	// 1.0: commit, push, and pull request merge events from the shell.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/session-delivery/index.ts",
};

function resolveConfig(raw: unknown): SessionDeliveryConfig {
	return { ...DEFAULT_SESSION_DELIVERY_CONFIG, ...((raw as Partial<SessionDeliveryConfig> | null | undefined) ?? {}) };
}

/** Fingerprint of what the detection reads: ids, roles, calls, results, and result texts. */
function deliveryFingerprint(messages: readonly MessageRow[]): string {
	return shortHash(
		messages
			.map((m) =>
				[
					m.id,
					m.role,
					m.timestamp ?? "",
					m.tool_calls ? shortHash(m.tool_calls) : "",
					m.tool_results ? shortHash(m.tool_results) : "",
					m.tool_results && m.content_text ? shortHash(m.content_text) : "",
				].join(":"),
			)
			.join("\n"),
	);
}

export const sessionDeliveryAnalyzer: Analyzer = {
	def: SESSION_DELIVERY_DEF,
	version: SESSION_DELIVERY_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: SESSION_DELIVERY_DEF.id,
		configHash: computeConfigHash(DEFAULT_SESSION_DELIVERY_CONFIG),
		configJson: DEFAULT_SESSION_DELIVERY_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		if (ctx.messages.length === 0) return [];
		const sources: SourceRef[] = [{ kind: "session", id: ctx.sessionId }];
		return [
			{
				sources,
				sourceSetHash: shortHash(`session-delivery(${ctx.sessionId}|${deliveryFingerprint(ctx.messages)})`),
				anchorKind: "session" as const,
				anchorRef: ctx.sessionId,
			},
		];
	},

	async analyze(_unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		const events = findDeliveryEvents(messages, config);
		const count = (kind: "commit" | "push" | "pr_merge") => {
			const of = events.filter((e) => e.kind === kind);
			return { attempted: of.length, succeeded: of.filter((e) => e.succeeded).length };
		};

		const properties: SessionDeliveryProperties = {
			session_id: ctx.sessionId,
			events,
			commit: count("commit"),
			push: count("push"),
			pr_merge: count("pr_merge"),
			delivered: events.some((e) => e.succeeded),
		};

		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
			...[...new Set(events.map((e) => e.call_message_id))].map((id, i) => ({
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
