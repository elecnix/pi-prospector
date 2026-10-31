/**
 * message-answers — the shared layer that asks classifier questions about a message.
 *
 * Analyzers register the questions they want answered (`message-questions.ts`).
 * This analyzer writes one metric node per message that has something to ask,
 * holding the answer to every question that applies to it. A request to the
 * decision model carries all the questions a message has no answer for, whoever
 * registered them, so the message is sent once for all of them.
 *
 * Which messages. Only a message whose origin a rule or the model settled, and
 * only when one of the registered questions lists that origin. The model reads the
 * person's own words: pasted blocks, quoted lines and harness blocks are cut out.
 * A message with none of its own words is skipped.
 *
 * Idempotency. A node's identity is its message, the decision model and the
 * registered question set. Re-running with the same set finds every node current
 * and sends nothing. Adding a question, or raising a question's version, moves the
 * set, so the nodes go stale for the `config` reason, and `--revise config` writes
 * a revised node for each message. The revised node carries forward every answer
 * whose question and version are unchanged and asks the model only for the rest.
 * A message whose answers are all carried forward costs no call.
 *
 * Without a `decisionModel` the analyzer plans nothing.
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
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeConfigHash, computeSourceSetHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { DecisionAnswer, decisionIdentity, type DecisionQuestion } from "../../decision-model.js";
import { MESSAGE_ORIGIN_DEF, type MessageOriginProperties } from "../message-origin/index.js";
import { originDecisionState } from "../message-origin/decision.js";
import { labelUserText } from "../../text-origin.js";
import { currentHits } from "../../../db/muted-terms.js";
import {
	messageQuestionsHash,
	questionKey,
	registeredMessageQuestions,
	type MessageQuestion,
} from "../../message-questions.js";
import { DEFAULT_MESSAGE_ANSWERS_CONFIG, type MessageAnswersConfig } from "./config.js";
import { Type, type Static } from "typebox";

/** Questions one request may carry (System One accepts up to 64). */
export const MAX_QUESTIONS_PER_REQUEST = 64;

export const MessageAnswersProperties = Type.Object({
	user_message_id: Type.String(),
	/** The answer to each question, under its key (`id.v<version>`). */
	answers: Type.Record(Type.String(), DecisionAnswer),
});
export type MessageAnswersProperties = Static<typeof MessageAnswersProperties>;

export const MESSAGE_ANSWERS_DEF: AnalyzerDef = {
	id: "message-answers",
	label: "Message Answers (decision model)",
	description:
		"Asks the classifier questions that analyzers registered about each message whose origin is settled, in one request per message, and stores the answers on the message's node. A question that already has an answer for the message is never sent again; a new or re-versioned question is asked on the next `--revise config` and the other answers are carried forward. Plans nothing when no decision model is configured.",
	anchorSpan: "pair",
	dependencies: [MESSAGE_ORIGIN_DEF.id],
	outputSchema: MessageAnswersProperties,
};

export const MESSAGE_ANSWERS_VERSION: AnalyzerVersion = {
	analyzerId: MESSAGE_ANSWERS_DEF.id,
	major: 1,
	minor: 0,
	implementationKind: "in_process_llm",
	codeRef: "src/analyze/analyzers/message-answers/index.ts",
};

const UnitMeta = Type.Object({
	/** The text the model reads: the person's own words. */
	text: Type.String(),
	/** Keys of the questions to send. */
	unanswered: Type.Array(Type.String()),
	/** Answers carried forward from the message's previous node. */
	carried: Type.Record(Type.String(), DecisionAnswer),
	originOutputKey: Type.String(),
	messageId: Type.String(),
});
type UnitMeta = Static<typeof UnitMeta>;

function ownWords(text: string): string {
	return labelUserText(text, { role: "user", childAgent: false, forkCopy: false })
		.filter((span) => span.origin === "typed")
		.map((span) => span.text)
		.join("\n")
		.trim();
}

function parse<T>(node: AnalysisNodeRow): T | null {
	try {
		return JSON.parse(node.content_json) as T;
	} catch {
		return null;
	}
}

export const messageAnswersAnalyzer: Analyzer = {
	def: MESSAGE_ANSWERS_DEF,
	version: MESSAGE_ANSWERS_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: MESSAGE_ANSWERS_DEF.id,
		configHash: computeConfigHash(DEFAULT_MESSAGE_ANSWERS_CONFIG),
		configJson: DEFAULT_MESSAGE_ANSWERS_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	// The registered question set is part of the identity, next to the model.
	modelsForIdentity(config): string[] {
		const cfg = config as unknown as MessageAnswersConfig | undefined;
		return cfg?.decisionModel ? [decisionIdentity(cfg.decisionModel, messageQuestionsHash())] : [];
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		const config = (ctx.config as unknown as MessageAnswersConfig | undefined) ?? DEFAULT_MESSAGE_ANSWERS_CONFIG;
		const questions = registeredMessageQuestions();
		if (!config.decisionModel || questions.length === 0) return [];

		const previous = new Map<string, MessageAnswersProperties>();
		for (const node of currentHits(ctx.ownNodes)) {
			const props = parse<MessageAnswersProperties>(node);
			if (props) previous.set(props.user_message_id, props);
		}
		const byId = new Map(ctx.messages.map((m) => [m.id, m]));

		const units: AnalysisUnit[] = [];
		for (const node of currentHits(ctx.dependencyNodes[MESSAGE_ORIGIN_DEF.id] ?? [])) {
			const origin = parse<MessageOriginProperties>(node);
			const message = origin ? byId.get(origin.user_message_id) : undefined;
			if (!origin || !origin.decided || !message) continue;
			const applicable: MessageQuestion[] = questions.filter((q) => q.origins.includes(origin.origin));
			if (applicable.length === 0) continue;
			const text = ownWords(message.content_text ?? "");
			if (text === "") continue;

			const before = previous.get(origin.user_message_id)?.answers ?? {};
			const carried: Record<string, DecisionAnswer> = {};
			const unanswered: string[] = [];
			for (const q of applicable) {
				const key = questionKey(q);
				const held = before[key];
				if (held && held.type === q.question.type) carried[key] = held;
				else unanswered.push(key);
			}
			const sources: SourceRef[] = [{ kind: "message", id: message.id }];
			units.push({
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "message",
				anchorRef: message.id,
				meta: { text, unanswered, carried, originOutputKey: node.output_key, messageId: message.id } satisfies UnitMeta as unknown as Record<string, unknown>,
			});
		}
		return units;
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = (ctx.config.configJson as unknown as MessageAnswersConfig) ?? DEFAULT_MESSAGE_ANSWERS_CONFIG;
		const meta = unit.meta as unknown as UnitMeta;
		const answers: Record<string, DecisionAnswer> = { ...meta.carried };

		let costUsd = 0;
		let inputTokens = 0;
		let outputTokens = 0;
		let durationMs = 0;
		let modelUsed: string | undefined;
		if (meta.unanswered.length > 0) {
			if (!config.decisionModel || !ctx.decide) {
				throw new Error(`message-answers is configured with decision model '${config.decisionModel}', but this run has no decision-model client.`);
			}
			const asked = new Map<string, DecisionQuestion>(
				registeredMessageQuestions().map((q) => [questionKey(q), q.question] as const),
			);
			for (let i = 0; i < meta.unanswered.length; i += MAX_QUESTIONS_PER_REQUEST) {
				const keys = meta.unanswered.slice(i, i + MAX_QUESTIONS_PER_REQUEST);
				const response = await ctx.decide({
					model: config.decisionModel,
					state: originDecisionState(meta.text),
					questions: Object.fromEntries(keys.map((key) => [key, asked.get(key)!])),
				});
				for (const key of keys) {
					const answer = response.answers[key];
					if (!answer) throw new Error(`Decision model returned no answer for '${key}'.`);
					answers[key] = answer;
				}
				modelUsed = response.model;
				costUsd += response.costUsd;
				inputTokens += response.inputTokens;
				outputTokens += response.outputTokens;
				durationMs += response.durationMs;
			}
		}

		const sorted = Object.fromEntries(Object.entries(answers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
		const properties: MessageAnswersProperties = { user_message_id: meta.messageId, answers: sorted };
		return {
			nodeKind: "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "message",
			anchorRef: unit.anchorRef,
			...(modelUsed
				? { modelUsed, costUsd, tokensUsed: inputTokens + outputTokens, inputTokens, cachedInputTokens: 0, outputTokens, durationMs }
				: {}),
			edges: [
				{ toRefKind: REF_KINDS.MESSAGE, toRefId: unit.anchorRef, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
				{ toRefKind: REF_KINDS.ANALYSIS_NODE, toRefId: meta.originOutputKey, edgeKind: EDGE_KINDS.CONSUMES, ordinal: 1 },
			],
		};
	},
};
