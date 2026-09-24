/**
 * What decode-collapse scores: documents cut from assistant generations.
 *
 * One assistant message yields up to two documents — its reasoning and its
 * answer text — because a collapsed generation typically spends a large
 * reasoning block on garbage and returns an empty answer, and the two halves of
 * one message can be coherent and corrupt independently.
 */

import { Type, type Static } from "typebox";
import type { AssistantGenerationRow } from "../../types.js";
import { shortHash } from "../../input-hash.js";
import { TokenizedDocument, tokenCount, tokenize } from "./ngram.js";
import type { DecodeCollapseConfig } from "./config.js";

export const DocumentField = Type.Union([Type.Literal("thinking"), Type.Literal("text")]);
export type DocumentField = Static<typeof DocumentField>;

export const GenerationDocument = Type.Object({
	message_id: Type.String(),
	field: DocumentField,
	model: Type.Union([Type.String(), Type.Null()]),
	tokens: TokenizedDocument,
	token_count: Type.Number(),
	/** Length and hash of the source text: what identity commits to. */
	fingerprint: Type.String(),
	/** The message returned no answer: no answer text and no tool call. */
	answer_empty: Type.Boolean(),
	/** Distinct chat-template control tokens the text leaked, e.g. `</tool_call>`. */
	control_tokens: Type.Array(Type.String()),
});
export type GenerationDocument = Static<typeof GenerationDocument>;

/**
 * Chat-template control tokens that sampling should never emit into prose. The
 * match is a fixed shape, so what is recorded is the template's own vocabulary,
 * never conversation content. On its own a match proves little — an agent
 * discussing chat templates writes these legitimately — so it is recorded as
 * corroboration beside the score, never as a verdict.
 */
const CONTROL_TOKEN_RE = /<\/?(?:arg_key|arg_value|tool_call|tool_response|function_call)>|<\|[a-z_]{2,32}\|>/gi;
const MAX_CONTROL_TOKENS = 5;

function controlTokens(text: string): string[] {
	const found = new Set<string>();
	for (const m of text.matchAll(CONTROL_TOKEN_RE)) {
		found.add(m[0].toLowerCase());
		if (found.size >= MAX_CONTROL_TOKENS) break;
	}
	return [...found].sort();
}

/** Whether the message recorded any tool call — an answer in its own right. */
function hasToolCalls(raw: string | null): boolean {
	const trimmed = raw?.trim() ?? "";
	return trimmed !== "" && trimmed !== "[]" && trimmed !== "null";
}

/** Every scoreable document of a session's assistant messages, in transcript order. */
export function extractDocuments(
	rows: readonly AssistantGenerationRow[],
	config: DecodeCollapseConfig,
): GenerationDocument[] {
	const docs: GenerationDocument[] = [];
	for (const row of rows) {
		if (row.role !== "assistant") continue;
		const answer = row.content_text ?? "";
		const answerEmpty = answer.trim().length === 0 && !hasToolCalls(row.tool_calls);
		const fields: Array<[DocumentField, string | null]> = [
			["thinking", row.content_thinking],
			["text", row.content_text],
		];
		for (const [field, text] of fields) {
			if (!text) continue;
			const tokens = tokenize(text, config.maxTokensPerDocument);
			const count = tokenCount(tokens);
			if (count < config.minDocumentTokens) continue;
			docs.push({
				message_id: row.id,
				field,
				model: row.model,
				tokens,
				token_count: count,
				fingerprint: `${text.length}:${shortHash(text)}`,
				answer_empty: answerEmpty,
				control_tokens: controlTokens(text),
			});
		}
	}
	return docs;
}

/** A stable digest of a session's documents, for its source ref. */
export function documentsFingerprint(docs: readonly GenerationDocument[]): string {
	return shortHash(docs.map((d) => `${d.message_id}:${d.field}:${d.fingerprint}`).join("\n"));
}
