/**
 * prompt-form — the shape of what a person typed, per session.
 *
 * The report asked for prompt length, question versus instruction versus
 * correction, and the use of lists or structure, month by month. One
 * session-anchored metric node per session folds those over the messages a
 * person typed (see `detect.ts` for the kinds and the measures). Length buckets
 * and counts add across sessions, so a monthly series is a sum of nodes.
 *
 * Origin comes from `message-origin`, consumed through `consumes` edges, and only
 * messages settled as `typed` are read. A node that is `decided: false` carries a
 * provisional label, so its message is counted in `undecided_message_count` and
 * its form is not read. The kind of each prompt (question, instruction,
 * correction, other) is the classifier's answer from `message-answers`, which
 * this analyzer registers a question with and then reads. It does not look for a
 * question mark. A prompt with no answer is `unknown`, which is not a count of
 * zero. A session with no typed message still gets a node of zero counts, so a
 * rate keeps its denominator.
 *
 * It calls no model itself and proposes nothing.
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
import { MESSAGE_ANSWERS_DEF, type MessageAnswersProperties } from "../message-answers/index.js";
import "./question.js";
import { DEFAULT_PROMPT_FORM_CONFIG, type PromptFormConfig } from "./config.js";
import { PromptKindOrUnknown, scanPromptForm, type TypedPrompt } from "./detect.js";
import { PROMPT_KINDS, PROMPT_KIND_KEY } from "./question.js";

/** The properties a prompt-form node carries in its `contentJson`. */
export const PROMPT_FORM_PROPERTIES = Type.Object({
	session_id: Type.String(),
	typed_message_count: Type.Number(),
	no_own_words_count: Type.Number(),
	undecided_message_count: Type.Number(),
	kinds: Type.Record(PromptKindOrUnknown, Type.Number()),
	sum_chars: Type.Number(),
	median_chars: Type.Union([Type.Number(), Type.Null()]),
	p90_chars: Type.Union([Type.Number(), Type.Null()]),
	max_chars: Type.Union([Type.Number(), Type.Null()]),
	length_buckets: Type.Array(Type.Object({ le_chars: Type.Union([Type.Number(), Type.Null()]), count: Type.Number() })),
	list_count: Type.Number(),
	heading_count: Type.Number(),
	code_block_count: Type.Number(),
});
export type PromptFormProperties = Static<typeof PROMPT_FORM_PROPERTIES>;

export const PROMPT_FORM_DEF: AnalyzerDef = {
	id: "prompt-form",
	label: "Prompt Form (deterministic)",
	description:
		"Measures the shape of what a person typed in a session: question, instruction, correction and other counts (a classifier's answer, or unknown), length (sum, median, 90th percentile, maximum, buckets), and how many prompts held a list, a heading, or a code block. Reads message-origin nodes and only messages settled as typed, in the person's own words after pasted and quoted text is cut; messages with an undecided origin are counted apart and not read. Each prompt's kind is a classifier answer from message-answers, or unknown. A session with no typed message gets zero counts. Deterministic, no LLM; it proposes nothing.",
	anchorSpan: "full_session",
	dependencies: [MESSAGE_ORIGIN_DEF.id, MESSAGE_ANSWERS_DEF.id],
	outputSchema: PROMPT_FORM_PROPERTIES,
};

export const PROMPT_FORM_VERSION: AnalyzerVersion = {
	analyzerId: PROMPT_FORM_DEF.id,
	// 1.0: kinds (a classifier answer, never punctuation), length, and structure of the typed prompts.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/prompt-form/index.ts",
};

function resolveConfig(raw: unknown): PromptFormConfig {
	return { ...DEFAULT_PROMPT_FORM_CONFIG, ...((raw as Partial<PromptFormConfig> | null | undefined) ?? {}) };
}

/** The newest successful node per key, parsed. */
function newestBy<T>(nodes: readonly AnalysisNodeRow[], key: (props: T) => string): Map<string, { node: AnalysisNodeRow; props: T }> {
	const newest = new Map<string, { node: AnalysisNodeRow; props: T }>();
	for (const node of nodes) {
		if (node.node_kind === "error") continue;
		const props = JSON.parse(node.content_json) as T;
		const k = key(props);
		const held = newest.get(k);
		if (!held || node.created_at > held.node.created_at || (node.created_at === held.node.created_at && node.id > held.node.id)) {
			newest.set(k, { node, props });
		}
	}
	return newest;
}

/** The message texts the scan reads enter the source set by hash: origin nodes carry only the label. */
function textFingerprint(messages: readonly MessageRow[], ids: ReadonlySet<string>): string {
	return shortHash(
		messages
			.filter((m) => ids.has(m.id))
			.map((m) => `${m.id}:${shortHash(m.content_text ?? "")}`)
			.join("\n"),
	);
}

/** The classifier's kind for a prompt, or `unknown` when it has no answer or a weak one. */
function kindOf(answers: MessageAnswersProperties | undefined, config: PromptFormConfig): TypedPrompt["kind"] {
	const answer = answers?.answers[PROMPT_KIND_KEY];
	if (!answer || answer.type !== "choice") return "unknown";
	const kind = PROMPT_KINDS.find((k) => k === answer.choice);
	if (!kind) return "unknown";
	return (answer.probabilities[answer.choice] ?? answer.confidence) >= config.minKindConfidence ? kind : "unknown";
}

interface Inputs {
	prompts: TypedPrompt[];
	undecided: number;
	nodes: AnalysisNodeRow[];
	typedIds: Set<string>;
}

function readInputs(
	messages: readonly MessageRow[],
	originNodes: readonly AnalysisNodeRow[],
	answerNodes: readonly AnalysisNodeRow[],
	config: PromptFormConfig,
): Inputs {
	const origins = newestBy<MessageOriginProperties>(originNodes, (p) => p.user_message_id);
	const answered = newestBy<MessageAnswersProperties>(answerNodes, (p) => p.user_message_id);
	const byId = new Map(messages.map((m) => [m.id, m]));
	const prompts: TypedPrompt[] = [];
	const typedIds = new Set<string>();
	let undecided = 0;
	for (const [id, { props }] of origins) {
		if (!props.decided) {
			undecided++;
			continue;
		}
		if (props.origin !== "typed") continue;
		const message = byId.get(id);
		if (!message) continue;
		typedIds.add(id);
		prompts.push({ text: message.content_text ?? "", kind: kindOf(answered.get(id)?.props, config) });
	}
	const nodes = [...[...origins.values()].map((v) => v.node), ...[...answered.values()].map((v) => v.node)];
	return { prompts, undecided, nodes, typedIds };
}

export const promptFormAnalyzer: Analyzer = {
	def: PROMPT_FORM_DEF,
	version: PROMPT_FORM_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: PROMPT_FORM_DEF.id,
		configHash: computeConfigHash(DEFAULT_PROMPT_FORM_CONFIG),
		configJson: DEFAULT_PROMPT_FORM_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		const originNodes = ctx.dependencyNodes[MESSAGE_ORIGIN_DEF.id] ?? [];
		if (ctx.messages.length === 0) return [];
		// A session with no user-role message has no origin node to wait for and still
		// earns a zero-count node. A session with user-role messages but no origin node
		// is missing its dependency, and a zero here would be false.
		const hasUserMessage = ctx.messages.some((m) => m.role === "user");
		if (originNodes.length === 0 && hasUserMessage) return [];
		const inputs = readInputs(ctx.messages, originNodes, ctx.dependencyNodes[MESSAGE_ANSWERS_DEF.id] ?? [], resolveConfig(ctx.config));
		const sources: SourceRef[] = [
			{ kind: "session", id: `${ctx.sessionId}#text=${textFingerprint(ctx.messages, inputs.typedIds)}` },
			...inputs.nodes.map((n) => ({ kind: "analysis_node" as const, id: n.output_key })),
		];
		return [{ sources, sourceSetHash: computeSourceSetHash(sources), anchorKind: "session" as const, anchorRef: ctx.sessionId }];
	},

	async analyze(_unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		const inputs = readInputs(
			messages,
			await ctx.getDependencyNodes(MESSAGE_ORIGIN_DEF.id),
			await ctx.getDependencyNodes(MESSAGE_ANSWERS_DEF.id),
			config,
		);
		const properties: PromptFormProperties = {
			session_id: ctx.sessionId,
			...scanPromptForm(inputs.prompts, inputs.undecided, config),
		};
		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
			...inputs.nodes.map((n, i) => ({
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
