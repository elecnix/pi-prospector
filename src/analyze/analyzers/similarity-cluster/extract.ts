/**
 * Item extraction for the similarity-cluster analyzer (issue #145).
 *
 * Pulls the three text domains out of one session's message rows, reusing the
 * shared action stream so tool-call pairing agrees with every other analyzer:
 *
 *   - user prompts — each `user` message's content_text (the turn boundary);
 *   - tool calls  — every invocation of the shared action stream;
 *   - tool results— `toolResult` rows carrying exactly ONE recorded result,
 *     whose content_text is that result's body. Rows joining several results'
 *     texts into one field are skipped for this domain: there is no honest way
 *     to split them back apart (the same limitation `tool-stream` documents
 *     for errorText).
 *
 * Also derives the per-session fingerprint that folds into a unit's source
 * set, so cross-session clustering re-identifies its units whenever any
 * contributing session's items change — identity commits to exact content.
 */

import { buildToolStream } from "../../tool-stream.js";
import type { MessageRow } from "../../types.js";
import type { SimilarityClusterConfig } from "./config.js";
import { tokenizePrompt, tokenizeResult, tokenizeToolCall } from "./tokenize.js";
import { hashTokens, type ClusterItem } from "./pipeline.js";
import type { SourceRef } from "../../types.js";
import { shortHash } from "../../input-hash.js";

/** The three domains extracted from one session. */
export interface SessionItems {
	prompts: ClusterItem[];
	toolCalls: ClusterItem[];
	toolResults: ClusterItem[];
}

interface RawToolResultEntry {
	toolCallId?: unknown;
	toolName?: unknown;
}

/**
 * Extract all three domains from one session's ordered messages. Deterministic
 * and pure in the messages; config only tunes tokenisation caps.
 */
export function extractItems(sessionId: string, messages: MessageRow[], cfg: SimilarityClusterConfig): SessionItems {
	const prompts: ClusterItem[] = [];
	const toolCalls: ClusterItem[] = [];
	const toolResults: ClusterItem[] = [];

	let turnOrdinal = -1;
	for (const m of messages) {
		if (m.role === "user") turnOrdinal++;

		if (m.role === "user" && m.content_text && m.content_text.trim().length > 0) {
			const tokens = tokenizePrompt(m.content_text);
			if (tokens.length > 0) {
				prompts.push({
					key: `${sessionId}:${m.id}:prompt`,
					sessionId,
					messageId: m.id,
					turnOrdinal: Math.max(turnOrdinal, 0),
					tokens,
					hash: hashTokens(tokens),
				});
			}
		}

		if (m.role === "toolResult" && m.content_text && m.tool_results) {
			let parsed: RawToolResultEntry[] | null = null;
			try {
				const value: unknown = JSON.parse(m.tool_results);
				if (Array.isArray(value)) parsed = value as RawToolResultEntry[];
			} catch (e) {
				throw new Error(`similarity-cluster: unparseable tool_results JSON on message ${m.id}: ${String(e)}`);
			}
			// Exactly one recorded result → content_text is honestly that result's
			// body. Multi-result rows are skipped (see module doc).
			if (parsed && parsed.length === 1) {
				const toolName = typeof parsed[0]!.toolName === "string" ? parsed[0]!.toolName : "unknown";
				// The tool name is part of the signal: different tools produce
				// structurally different text. The newline keeps name and body apart.
				const tokens = tokenizeResult(`${toolName}\n${m.content_text}`, cfg.maxResultTokens);
				// Detector 2's min_nodes is a SKIP, not just a nomination floor:
				// one-line results ("ok", empty output) carry no comparable signal,
				// and letting them form exact classes would propose "read ok 14×".
				if (tokens.length >= cfg.minTokensResults) {
					toolResults.push({
						key: `${sessionId}:${m.id}:result`,
						sessionId,
						messageId: m.id,
						turnOrdinal: Math.max(turnOrdinal, 0),
						tokens,
						hash: hashTokens(tokens),
					});
				}
			}
		}
	}

	for (const inv of buildToolStream(messages).invocations) {
		const tokens = tokenizeToolCall(inv.name, inv.args);
		// A bare tool name carries nothing comparable; calls otherwise keep the
		// short-item carve-out — exact duplicates like read(AGENTS.md) ARE signal.
		if (tokens.length <= 1) continue;
		toolCalls.push({
			key: `${sessionId}:${inv.messageId}:${inv.ordinal}`,
			sessionId,
			messageId: inv.messageId,
			turnOrdinal: Math.max(turnOrdinal, 0),
			tokens,
			hash: hashTokens(tokens),
		});
	}

	return { prompts, toolCalls, toolResults };
}

/** Every item of a {@link SessionItems} bundle as one array (fingerprinting). */
function allItems(s: SessionItems): ClusterItem[] {
	return [...s.prompts, ...s.toolCalls, ...s.toolResults];
}

/**
 * Fingerprint of one session's extracted items: detector + ordinal + normalised
 * hash per item. Folded into a unit's source set as `<sessionId>:<fingerprint>`,
 * so adding/removing/changing any of the session's items re-identifies every
 * unit that pools it.
 */
export function sessionItemsFingerprint(items: SessionItems): string {
	const lines = allItems(items)
		.map((it) => `${it.key}:${it.hash}`)
		.sort();
	lines.push(`n:${lines.length}`);
	return shortHash(lines.join("\n"));
}

/** The self source ref carrying the session's own item fingerprint. */
export function selfSourceRef(sessionId: string, fingerprint: string): SourceRef {
	return { kind: "session", id: `${sessionId}#similarity=${fingerprint}` };
}

/** A sibling source ref: session id plus its item fingerprint. */
export function siblingSourceRef(sessionId: string, fingerprint: string): SourceRef {
	return { kind: "session", id: `${sessionId}:${fingerprint}` };
}
