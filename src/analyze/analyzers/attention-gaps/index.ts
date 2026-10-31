/**
 * attention-gaps — how long the agent waited for a person.
 *
 * The report asks whether the operator supervises less: the time between an agent
 * finishing and the next message a person typed, and the share of sessions that
 * wait on a person at all. One session-anchored metric node per session, with the
 * count of typed messages, the gap statistics and buckets (see `detect.ts`), and
 * the longest gaps with their messages as evidence.
 *
 * Origin comes from `message-origin`, consumed through `consumes` edges. Only a
 * message a rule or the model settled as `typed` is attention. A node that is
 * `decided: false` keeps the provisional label `typed` and is counted apart, so a
 * message nobody could place never moves the statistics. A session with no typed
 * message still gets a node with zero counts, because "no person was involved" is
 * a finding and a rate over sessions needs the denominator.
 *
 * Deterministic, no LLM, and it proposes nothing.
 */

import type {
	Analyzer,
	AnalyzerDef,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	AnalysisNodeRow,
	AnalysisResult,
	AnalysisUnit,
	MessageRow,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeConfigHash, computeSourceSetHash, shortHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { Type, type Static } from "typebox";
import { MESSAGE_ORIGIN_DEF, type MessageOriginProperties } from "../message-origin/index.js";
import { DEFAULT_ATTENTION_GAPS_CONFIG, type AttentionGapsConfig } from "./config.js";
import { scanAttention, type OriginRead } from "./detect.js";

/** The properties an attention-gaps node carries in its `contentJson`. */
export const ATTENTION_GAPS_PROPERTIES = Type.Object({
	session_id: Type.String(),
	typed_message_count: Type.Number(),
	undecided_message_count: Type.Number(),
	gap_count: Type.Number(),
	unmeasured_typed_count: Type.Number(),
	undecided_gap_count: Type.Number(),
	sum_seconds: Type.Number(),
	median_seconds: Type.Union([Type.Number(), Type.Null()]),
	p90_seconds: Type.Union([Type.Number(), Type.Null()]),
	max_seconds: Type.Union([Type.Number(), Type.Null()]),
	buckets: Type.Array(Type.Object({ le_seconds: Type.Union([Type.Number(), Type.Null()]), count: Type.Number() })),
	longest: Type.Array(Type.Object({ user_message_id: Type.String(), seconds: Type.Number() })),
});
export type AttentionGapsProperties = Static<typeof ATTENTION_GAPS_PROPERTIES>;

export const ATTENTION_GAPS_DEF: AnalyzerDef = {
	id: "attention-gaps",
	label: "Attention Gaps (deterministic)",
	description:
		"Measures how long the agent waited for a person: the time from the agent's last activity to each message a person typed, as count, median, 90th percentile, maximum, buckets, and the longest gaps with their messages. Reads message-origin nodes and counts only messages settled as typed. Messages whose origin is undecided are counted apart and never enter the statistics. A session with no typed message gets zero counts. Deterministic, no LLM; it proposes nothing.",
	anchorSpan: "full_session",
	dependencies: [MESSAGE_ORIGIN_DEF.id],
	outputSchema: ATTENTION_GAPS_PROPERTIES,
};

export const ATTENTION_GAPS_VERSION: AnalyzerVersion = {
	analyzerId: ATTENTION_GAPS_DEF.id,
	// 1.0: gaps from the agent's last activity to each typed message.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/attention-gaps/index.ts",
};

function resolveConfig(raw: unknown): AttentionGapsConfig {
	return { ...DEFAULT_ATTENTION_GAPS_CONFIG, ...((raw as Partial<AttentionGapsConfig> | null | undefined) ?? {}) };
}

/** The newest successful message-origin node per message, parsed. */
function readOrigins(nodes: readonly AnalysisNodeRow[]): { reads: Map<string, OriginRead>; used: AnalysisNodeRow[] } {
	const newest = new Map<string, { node: AnalysisNodeRow; props: MessageOriginProperties }>();
	for (const node of nodes) {
		if (node.node_kind === "error") continue;
		const props = JSON.parse(node.content_json) as MessageOriginProperties;
		const held = newest.get(props.user_message_id);
		if (!held || node.created_at > held.node.created_at || (node.created_at === held.node.created_at && node.id > held.node.id)) {
			newest.set(props.user_message_id, { node, props });
		}
	}
	const reads = new Map<string, OriginRead>();
	for (const [id, { props }] of newest) reads.set(id, { origin: props.origin, decided: props.decided });
	return { reads, used: [...newest.values()].map((v) => v.node) };
}

/** Fingerprint of the timing the gaps read: each message's id, role, and timestamp. */
function timingFingerprint(messages: readonly MessageRow[]): string {
	return shortHash(messages.map((m) => `${m.id}:${m.role}:${m.timestamp ?? ""}`).join("\n"));
}

export const attentionGapsAnalyzer: Analyzer = {
	def: ATTENTION_GAPS_DEF,
	version: ATTENTION_GAPS_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: ATTENTION_GAPS_DEF.id,
		configHash: computeConfigHash(DEFAULT_ATTENTION_GAPS_CONFIG),
		configJson: DEFAULT_ATTENTION_GAPS_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		const origins = readOrigins(ctx.dependencyNodes[MESSAGE_ORIGIN_DEF.id] ?? []);
		const originNodes = origins.used;
		if (ctx.messages.length === 0) return [];
		// A session with no user-role message has no origin node to wait for and still
		// earns a zero-count node. A session with user-role messages but no origin node
		// is missing its dependency, and a zero here would be false.
		const hasUserMessage = ctx.messages.some((m) => m.role === "user");
		if (originNodes.length === 0 && hasUserMessage) return [];
		// The origin nodes carry only the message, so the timing the gaps read enters
		// the source set separately: a backfilled timestamp re-identifies the unit.
		const sources: SourceRef[] = [
			{ kind: "session", id: `${ctx.sessionId}#timing=${timingFingerprint(ctx.messages)}` },
			...origins.used.map((n) => ({ kind: "analysis_node" as const, id: n.output_key })),
		];
		return [
			{
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "session" as const,
				anchorRef: ctx.sessionId,
			},
		];
	},

	async analyze(_unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		const { reads, used } = readOrigins(await ctx.getDependencyNodes(MESSAGE_ORIGIN_DEF.id));
		const properties: AttentionGapsProperties = { session_id: ctx.sessionId, ...scanAttention(messages, reads, config) };

		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
			...used.map((n, i) => ({
				toRefKind: REF_KINDS.ANALYSIS_NODE,
				toRefId: n.output_key,
				edgeKind: EDGE_KINDS.CONSUMES,
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
