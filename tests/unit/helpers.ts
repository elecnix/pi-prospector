import type { MessageRow } from "../../src/analyze/types.js";

let rowSeq = 0;

/**
 * A synthetic MessageRow with every optional field empty, so a test overrides
 * only what it cares about. Ids are auto-generated when not supplied.
 */
export function makeMessageRow(over: Partial<MessageRow> = {}): MessageRow {
	const id = over.id ?? `row-${rowSeq++}`;
	return {
		session_id: "s1",
		parent_id: null,
		timestamp: null,
		role: "assistant",
		content_text: null,
		content_thinking: null,
		tool_calls: null,
		tool_results: null,
		model: null,
		cost_usd: null,
		stop_reason: null,
		error_message: null,
		...over,
		id,
	};
}
