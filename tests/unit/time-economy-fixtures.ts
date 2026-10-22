/**
 * Shared fixtures for the time-economy analyzer's unit tests (issue #306).
 *
 * Hand-written synthetic message rows with explicit timestamps — no real
 * session data, no database, no mocks. Both the timing tests and the span
 * tests build on these, so a row's shape is defined once.
 *
 * This is a helper module, not a test file: the runner only picks up
 * `tests/unit/*.test.ts`.
 */

import type { BackgroundTaskRow, MessageRow } from "../../src/analyze/types.js";
import type { SpanRow } from "../../src/analyze/analyzers/time-economy/phases.js";

/** The instant the synthetic fixtures start at. */
export const T0 = Date.parse("2026-01-01T00:00:00.000Z");

/** An ISO timestamp `s` seconds after the fixture's start. */
export function at(s: number): string {
	return new Date(T0 + s * 1000).toISOString();
}

let seq = 0;

/** A message row with every column the analyzer reads, defaulted. */
export function row(partial: Partial<MessageRow> & { role: string }): MessageRow {
	const id = partial.id ?? `row-${seq++}`;
	return {
		id,
		session_id: "s",
		parent_id: null,
		timestamp: null,
		content_text: null,
		content_thinking: null,
		tool_calls: null,
		tool_results: null,
		model: null,
		cost_usd: null,
		stop_reason: null,
		error_message: null,
		...partial,
	};
}

/** A span row: a message row with the usage column attached. */
export function spanRow(partial: Partial<SpanRow> & { role: string }): SpanRow {
	return { ...row(partial), usage: partial.usage ?? null } as SpanRow;
}

/** An assistant row issuing one shell call at second `s`. */
export function shell(id: string, command: string, s: number | null, extra: Record<string, unknown> = {}): MessageRow {
	return row({
		id: `call-${id}`,
		role: "assistant",
		timestamp: s === null ? null : at(s),
		tool_calls: JSON.stringify([{ id, name: "bash", arguments: { command, ...extra } }]),
	});
}

/** An assistant row issuing one non-shell call. */
export function tool(id: string, name: string, args: Record<string, unknown>, s: number | null): MessageRow {
	return row({
		id: `call-${id}`,
		role: "assistant",
		timestamp: s === null ? null : at(s),
		tool_calls: JSON.stringify([{ id, name, arguments: args }]),
	});
}

/** The tool-result row answering call `id` at second `s`. */
export function result(id: string, s: number | null, isError = false, text: string | null = null): MessageRow {
	return row({
		id: `res-${id}`,
		role: "toolResult",
		timestamp: s === null ? null : at(s),
		content_text: text,
		tool_results: JSON.stringify([{ toolCallId: id, toolName: "bash", isError, textLength: text?.length ?? 10 }]),
	});
}

/** A background task's completion, as the host recorded it. */
export function backgroundTask(toolUseId: string, completedAt: string, status = "completed"): BackgroundTaskRow {
	return {
		session_id: "s",
		tool_use_id: toolUseId,
		task_id: "task-1",
		completed_at: completedAt,
		status,
		summary: "Background command finished",
	};
}
