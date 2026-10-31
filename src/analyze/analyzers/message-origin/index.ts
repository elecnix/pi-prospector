/**
 * message-origin — who wrote each user-role message.
 *
 * Emits one `metric` node per turn-starting message, labelled `typed`, `pasted`,
 * `agent` or `notification` (see `message-origin.ts` for the definitions and the
 * rules). The label is a fact about the message alone, so the source set is the
 * message and nothing else: a turn keeps its node when its neighbours change.
 *
 * Deterministic rules decide almost every message. A message with only a weak
 * sign of machine authorship is `undecided`; when `decisionModel` is configured
 * the analyzer asks it, and otherwise the node says `decided: false` and keeps
 * the provisional label `typed`. Nothing here ever calls a model for a message a
 * rule has decided, so a full-corpus run costs only the undecided remainder.
 *
 * Relation to `turn-frustration`'s `origin` field: that field labels the *spans*
 * a hit's words fall in (`text-origin.ts`), so one message can split across
 * labels. This analyzer labels the *whole message* and adds the rules span
 * labelling cannot have: a prompt an orchestrator wrote for a worker carries no
 * tag a span rule could see. Both read the same harness blocks through
 * `labelUserText`; a report that wants only a person's words joins a hit to its
 * message's node through the shared message anchor.
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
import { decisionIdentity } from "../../decision-model.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { TURN_PAIR_CORE_DEF } from "../turn-pair-core/index.js";
import { getSessionLineage } from "../../../db/queries.js";
import { classifyMessageOrigin, MessageOrigin, OriginRule, OriginSuspicion, OriginVerdict } from "../../message-origin.js";
import { DEFAULT_MESSAGE_ORIGIN_CONFIG, type MessageOriginConfig } from "./config.js";
import {
	ORIGIN_DECISION_QUESTIONS,
	ORIGIN_DECISION_QUESTIONS_HASH,
	originDecisionState,
	parseOriginDecision,
} from "./decision.js";
import { Type, type Static } from "typebox";

export const MessageOriginProperties = Type.Object({
	user_message_id: Type.String(),
	pair_index: Type.Number(),
	origin: MessageOrigin,
	/** The rule that decided the label, `decision-model` when the model settled it, or `undecided`. */
	rule: OriginRule,
	/** False when no rule and no model settled the message; `origin` is then provisional. */
	decided: Type.Boolean(),
	/** Weak signs of machine authorship that sent the message to the model. */
	suspicions: Type.Array(OriginSuspicion),
	/** The decision model's distribution per question, when it was asked. */
	probabilities: Type.Optional(Type.Record(Type.String(), Type.Record(Type.String(), Type.Number()))),
});
export type MessageOriginProperties = Static<typeof MessageOriginProperties>;

export const MESSAGE_ORIGIN_DEF: AnalyzerDef = {
	id: "message-origin",
	label: "Message Origin (deterministic first)",
	description:
		"Labels each turn-starting user-role message with who wrote it: typed (a person composed it), pasted (a person sent copied material), agent (an agent or script wrote it) or notification (the harness injected it). Named rules decide almost every message; a message with only a weak sign of machine authorship goes to a decision model when one is configured.",
	anchorSpan: "pair",
	dependencies: [TURN_PAIR_CORE_DEF.id],
	outputSchema: MessageOriginProperties,
};

export const MESSAGE_ORIGIN_VERSION: AnalyzerVersion = {
	analyzerId: MESSAGE_ORIGIN_DEF.id,
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/message-origin/index.ts",
};

const UnitMeta = Type.Object({
	verdict: OriginVerdict,
	properties: Type.Object({ user_message_id: Type.String(), pair_index: Type.Number() }),
	/** The message text, kept only when the decision model may be asked. */
	text: Type.Union([Type.String(), Type.Null()]),
});
type UnitMeta = Static<typeof UnitMeta>;

export const messageOriginAnalyzer: Analyzer = {
	def: MESSAGE_ORIGIN_DEF,
	version: MESSAGE_ORIGIN_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: MESSAGE_ORIGIN_DEF.id,
		configHash: computeConfigHash(DEFAULT_MESSAGE_ORIGIN_CONFIG),
		configJson: DEFAULT_MESSAGE_ORIGIN_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	modelsForIdentity(config): string[] {
		const cfg = config as unknown as MessageOriginConfig | undefined;
		return cfg?.decisionModel ? [decisionIdentity(cfg.decisionModel, ORIGIN_DECISION_QUESTIONS_HASH)] : [];
	},

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		const roles = new Map(ctx.messages.map((m) => [m.id, m.role]));
		// A message whose predecessor is an assistant message with tool calls and no
		// result in between may be the call's result, filed under the user role.
		const secondsAfterToolCall = new Map<string, number>();
		ctx.messages.forEach((m, i) => {
			const prev = ctx.messages[i - 1];
			if (prev?.role !== "assistant" || !prev.tool_calls || prev.tool_calls === "[]") return;
			const gap = (Date.parse(m.timestamp ?? "") - Date.parse(prev.timestamp ?? "")) / 1000;
			if (Number.isFinite(gap)) secondsAfterToolCall.set(m.id, gap);
		});
		// A session with a parent link is a child agent's unless it is a pi fork,
		// where the parent link records a fork and the person kept typing.
		const lineage = await getSessionLineage(ctx.db, ctx.sessionId);
		const childAgent = lineage?.parent_session != null && lineage.source !== "pi";

		const units: AnalysisUnit[] = [];
		for (const pair of await ctx.getTurnPairs(ctx.sessionId)) {
			if (!pair.userText.trim()) continue;
			const verdict = classifyMessageOrigin(pair.userText, {
				role: roles.get(pair.userMessageId) ?? "user",
				childAgent,
				secondsAfterToolCall: secondsAfterToolCall.get(pair.userMessageId) ?? null,
			});
			const sources: SourceRef[] = [{ kind: "message", id: pair.userMessageId }];
			units.push({
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "message",
				anchorRef: pair.userMessageId,
				meta: {
					verdict,
					properties: { user_message_id: pair.userMessageId, pair_index: pair.index },
					text: verdict.decided ? null : pair.userText,
				} satisfies UnitMeta as unknown as Record<string, unknown>,
			});
		}
		return units;
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = (ctx.config.configJson as unknown as MessageOriginConfig) ?? DEFAULT_MESSAGE_ORIGIN_CONFIG;
		const meta = unit.meta as unknown as UnitMeta;
		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.MESSAGE, toRefId: unit.anchorRef, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
		];
		const base = { ...meta.properties, ...meta.verdict };

		if (meta.verdict.decided || !config.decisionModel || meta.text === null) {
			return { nodeKind: "metric", contentJson: base as unknown as Record<string, unknown>, anchorKind: "message", anchorRef: unit.anchorRef, edges };
		}
		if (!ctx.decide) {
			throw new Error(`message-origin is configured with decision model '${config.decisionModel}', but this run has no decision-model client.`);
		}
		const response = await ctx.decide({
			model: config.decisionModel,
			state: originDecisionState(meta.text),
			questions: ORIGIN_DECISION_QUESTIONS,
		});
		const decision = parseOriginDecision(response);
		const settled = decision.confidence >= config.minConfidence;
		const properties: MessageOriginProperties = {
			...base,
			origin: settled ? decision.origin : base.origin,
			rule: settled ? "decision-model" : "undecided",
			decided: settled,
			probabilities: decision.probabilities,
		};
		return {
			nodeKind: "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "message",
			anchorRef: unit.anchorRef,
			modelUsed: response.model,
			costUsd: response.costUsd,
			tokensUsed: response.inputTokens + response.outputTokens,
			inputTokens: response.inputTokens,
			cachedInputTokens: 0,
			outputTokens: response.outputTokens,
			durationMs: response.durationMs,
			edges,
		};
	},
};
