import type { MessageRow } from "../../src/analyze/types.js";
import type { Proposal } from "../../src/types.js";

let rowSeq = 0;

/**
 * A synthetic Proposal row with every nullable field empty, so a test overrides
 * only what it cares about.
 */
export function makeProposal(overrides: Partial<Proposal>): Proposal {
	return {
		id: "id",
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		session_id: "sess",
		source_node_id: null,
		analyzer_id: "session-overview",
		target_type: "agents_md",
		target_path: null,
		title: "t",
		severity: "friction",
		summary: "s",
		detail: null,
		evidence: null,
		confidence: null,
		cost_usd: null,
		status: "open",
		input_key: "k",
		source_message_ids: null,
		validated_score: null,
		validation_status: "unvalidated",
		validation_node_id: null,
		...overrides,
	};
}

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
