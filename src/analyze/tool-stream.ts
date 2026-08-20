/**
 * The session's action stream, reconstructed once for every analyzer that needs it.
 *
 * Two kinds of thing go wrong in a session, and they are not the same kind of
 * thing:
 *
 *   - a **tool failure** — the model asked for a well-formed action and the tool
 *     itself refused or errored;
 *   - a **turn failure** — the model's own generation never produced a usable
 *     result at all, so no tool was ever reached.
 *
 * Both are read from the same message stream, so both live here. Keeping the
 * reconstruction in one module is what lets the trajectory analyzer and the
 * failure analyzer agree on what "the third call" and "that call failed" mean;
 * two private walkers over the same rows would drift the moment either was fixed.
 *
 * Pairing is by the provider's tool-call id. An earlier positional walk paired
 * the Nth call with the Nth result gathered from a map, which mis-attributed
 * every error in any session where a step issued several calls or a result never
 * arrived — the errors landed on the wrong calls, silently.
 */

import type { MessageRow } from "./types.js";

/** A tool result, as recorded on the message that carried it. */
export interface ToolOutcome {
	/** The message row that carried the result. */
	messageId: string;
	isError: boolean;
	/** Length of the result text, as recorded at ingest. */
	textLength: number;
	/**
	 * The failed result's text, or null.
	 *
	 * Only populated when the carrying row held exactly one result, because the
	 * transcript joins several results' texts into a single field and there is no
	 * honest way to split them back apart. A guess here would attribute one
	 * tool's error message to another tool.
	 */
	errorText: string | null;
}

/** One tool call in the session's ordered action stream, with its outcome. */
export interface ToolInvocation {
	/** The provider's tool-call id, or "" when the transcript recorded none. */
	callId: string;
	name: string;
	args: Record<string, unknown>;
	/** The assistant message that issued the call. */
	messageId: string;
	/** Position in the session's tool-call stream, from 0. */
	ordinal: number;
	/** The paired result, or null when none was ever recorded (an abandoned call). */
	outcome: ToolOutcome | null;
	/** Billed cost of the assistant turn that issued the call, or null when unrecorded. */
	costUsd: number | null;
}

/**
 * An assistant generation that ended in a recorded failure.
 *
 * The tokens were billed and nothing usable came back, so a turn failure is
 * simultaneously the most expensive kind of friction and the one no analyzer
 * could see before sync captured `stop_reason`/`error_message`.
 */
export interface TurnFailure {
	messageId: string;
	/** The host's stop reason, verbatim. */
	stopReason: string | null;
	/** The host's error text, verbatim. Empty when the host recorded a failure with no text. */
	errorText: string;
	/** Billed cost of the failed generation, or null when unrecorded. */
	costUsd: number | null;
}

/** What the stream could and could not be read from — coverage, never assumed. */
export interface StreamCoverage {
	/** Assistant messages in the session. */
	assistantTurnCount: number;
	/** Tool calls issued. */
	toolCallCount: number;
	/**
	 * Whether the session carries any `stop_reason` at all. False means the rows
	 * were indexed before sync captured it, so "no turn failures" means "not
	 * known", not "none happened". A full re-sync backfills it.
	 */
	stopReasonRecorded: boolean;
}

export interface ToolStream {
	invocations: ToolInvocation[];
	turnFailures: TurnFailure[];
	coverage: StreamCoverage;
}

interface RawResult {
	toolCallId: string;
	toolName: string;
	isError: boolean;
	textLength: number;
}

/**
 * Reconstruct a session's action stream from its messages, in order.
 *
 * Calls are matched to results by tool-call id. Calls or results that carry no
 * id — older transcripts — fall back to first-in-first-out matching *among the
 * id-less ones only*, so the presence of one legacy row cannot dislodge the
 * exact pairings around it.
 */
export function buildToolStream(messages: MessageRow[]): ToolStream {
	const invocations: ToolInvocation[] = [];
	const turnFailures: TurnFailure[] = [];
	let assistantTurnCount = 0;
	let stopReasonRecorded = false;

	// Pass 1: the calls, in stream order.
	for (const m of messages) {
		if (m.role === "assistant") {
			assistantTurnCount++;
			if (m.stop_reason !== null && m.stop_reason !== undefined) stopReasonRecorded = true;
			if (isTurnFailure(m)) {
				turnFailures.push({
					messageId: m.id,
					stopReason: m.stop_reason ?? null,
					errorText: m.error_message ?? "",
					costUsd: typeof m.cost_usd === "number" && m.cost_usd > 0 ? m.cost_usd : null,
				});
			}
		}
		if (m.role !== "assistant" || !m.tool_calls) continue;
		for (const tc of parseToolCalls(m.tool_calls)) {
			invocations.push({
				callId: tc.id,
				name: tc.name,
				args: tc.arguments,
				messageId: m.id,
				ordinal: invocations.length,
				outcome: null,
				costUsd: typeof m.cost_usd === "number" && m.cost_usd > 0 ? m.cost_usd : null,
			});
		}
	}

	// Pass 2: the results, matched back to the calls that asked for them.
	const byCallId = new Map<string, ToolInvocation>();
	for (const inv of invocations) {
		if (inv.callId && !byCallId.has(inv.callId)) byCallId.set(inv.callId, inv);
	}
	const idless = invocations.filter((inv) => !inv.callId);
	let idlessCursor = 0;

	for (const m of messages) {
		if (m.role !== "toolResult" || !m.tool_results) continue;
		const results = parseToolResults(m.tool_results);
		for (const r of results) {
			const target = r.toolCallId ? byCallId.get(r.toolCallId) : idless[idlessCursor++];
			if (!target || target.outcome) continue;
			target.outcome = {
				messageId: m.id,
				isError: r.isError,
				textLength: r.textLength,
				// One result on the row → its text is unambiguously this result's.
				errorText: r.isError && results.length === 1 ? (m.content_text ?? null) : null,
			};
		}
	}

	return {
		invocations,
		turnFailures,
		coverage: { assistantTurnCount, toolCallCount: invocations.length, stopReasonRecorded },
	};
}

/**
 * Whether an assistant row records a failed generation.
 *
 * `aborted` is deliberately included: the host recorded it as a non-completion
 * and the classifier — not this function — is what decides an abort is the
 * operator's doing rather than a defect.
 */
function isTurnFailure(m: MessageRow): boolean {
	if (m.error_message) return true;
	const sr = m.stop_reason;
	return sr === "error" || sr === "aborted";
}

/** Parse the stored `tool_calls` JSON, tolerating older shapes and malformed rows. */
export function parseToolCalls(json: string): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
	for (const raw of parsed) {
		if (!raw || typeof raw !== "object") continue;
		const tc = raw as Record<string, unknown>;
		// Stored calls carry their arguments under `arguments`; rows written by an
		// older parser, and Claude's own shape, use `input`.
		const args = tc["arguments"] ?? tc["input"];
		out.push({
			id: typeof tc["id"] === "string" ? tc["id"] : "",
			name: typeof tc["name"] === "string" ? tc["name"] : "",
			arguments: args && typeof args === "object" ? (args as Record<string, unknown>) : {},
		});
	}
	return out;
}

/** Parse the stored `tool_results` JSON, tolerating malformed rows. */
function parseToolResults(json: string): RawResult[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: RawResult[] = [];
	for (const raw of parsed) {
		if (!raw || typeof raw !== "object") continue;
		const tr = raw as Record<string, unknown>;
		out.push({
			toolCallId: typeof tr["toolCallId"] === "string" ? tr["toolCallId"] : "",
			toolName: typeof tr["toolName"] === "string" ? tr["toolName"] : "",
			isError: Boolean(tr["isError"]),
			textLength: typeof tr["textLength"] === "number" ? tr["textLength"] : 0,
		});
	}
	return out;
}
