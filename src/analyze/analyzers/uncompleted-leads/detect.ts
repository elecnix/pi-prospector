/**
 * Session lead scan and completion matching (issue #216).
 *
 * Reads the session's action stream through the shared seam
 * (`src/analyze/tool-stream.ts`) — the same reconstruction every analyzer that
 * reads what the agent did uses, so "that result" means one thing everywhere.
 *
 * A lead is *completed* when a matching tool call appears within
 * `completionWindow` calls after the call whose output surfaced it; otherwise it
 * is flagged uncompleted. Matching is deliberately literal: a path completes
 * when a later call names it, a URL when a later fetch names it, a suggested
 * command when a later bash invocation runs it.
 */

import { Type, type Static } from "typebox";
import type { MessageRow } from "../../types.js";
import { buildToolStream, parseToolCalls, type ToolInvocation } from "../../tool-stream.js";
import { DEFAULT_UNCOMPLETED_LEADS_CONFIG, LeadTypeSchema, type UncompletedLeadsConfig } from "./config.js";
import { extractLeads } from "./extract.js";

/** One surfaced lead, with its completion verdict. */
export const Lead = Type.Object({
	type: LeadTypeSchema,
	value: Type.String(),
	/** The toolResult message whose text surfaced the lead. */
	source_message_id: Type.String(),
	/** Ordinal of the tool call whose output surfaced the lead. */
	tool_call_ordinal: Type.Number(),
	status: Type.Union([Type.Literal("completed"), Type.Literal("uncompleted")]),
	/** The assistant message carrying the completing call, or null while uncompleted. */
	completed_by_message_id: Type.Union([Type.String(), Type.Null()]),
});
export type Lead = Static<typeof Lead>;

/** Tools whose string arguments naming a path count as pursuing that path. */
const PATH_TOOLS = new Set(["read", "edit", "write", "grep", "glob", "view", "list", "search"]);
/** Tools whose arguments naming a URL count as fetching it. */
const FETCH_TOOLS = new Set(["webfetch", "fetch", "browser_open", "browser_navigate", "open_url"]);

function stringArgValues(inv: ToolInvocation): string[] {
	return Object.values(inv.args).filter((v): v is string => typeof v === "string");
}

/**
 * Whether `invocation` pursues the lead — i.e. whether a matching call appears
 * among the invocations strictly after the surfacing call, within the window.
 *
 * Exported as a pure function so the compression-checklist analyzer can ask the
 * identical question of post-compaction calls (issue #218) without a second
 * walker that could drift — the same precedent as presidio reusing piicatcher's
 * recognizer stack: shared pure functions, no analysis dependency declared.
 */
export function matchesLead(leadType: string, value: string, invocation: ToolInvocation): boolean {
	if (invocation.name === "bash") {
		const command = stringArgValues(invocation).join(" ");
		if (leadType === "command") {
			const trimmed = command.trim();
			return trimmed === value || trimmed.startsWith(`${value} `);
		}
		// Path or URL named inside a shell command counts as pursuing it.
		return command.includes(value);
	}
	if (leadType === "path" && PATH_TOOLS.has(invocation.name)) {
		return stringArgValues(invocation).some((v) => v === value || v.endsWith(`/${value}`) || value.endsWith(`/${v}`));
	}
	if (leadType === "url" && FETCH_TOOLS.has(invocation.name)) {
		return stringArgValues(invocation).some((v) => v.includes(value));
	}
	return false;
}

interface RawResultEntry {
	toolCallId: string;
	isError: boolean;
}

/** Parse the stored `tool_results` JSON envelope, tolerating malformed rows. */
function parseResultEntries(json: string): RawResultEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: RawResultEntry[] = [];
	for (const raw of parsed) {
		if (!raw || typeof raw !== "object") continue;
		const tr = raw as Record<string, unknown>;
		out.push({
			toolCallId: typeof tr["toolCallId"] === "string" ? tr["toolCallId"] : "",
			isError: Boolean(tr["isError"]),
		});
	}
	return out;
}

/**
 * Resolve the text captured for one invocation's result, or null.
 *
 * Errored results read their text from the action stream (`outcome.errorText`,
 * populated only when the carrying row held exactly one result); successful
 * results read the carrying row's content_text under the same single-result
 * rule. An ambiguous multi-result row is claimed by nobody — a guess here would
 * attribute one tool's output to another.
 */
export function resolvedResultText(inv: ToolInvocation, messagesById: Map<string, MessageRow>): string | null {
	const outcome = inv.outcome;
	if (!outcome) return null;
	const row = messagesById.get(outcome.messageId);
	const entries = row && typeof row.tool_results === "string" ? parseResultEntries(row.tool_results) : [];
	if (entries.length !== 1) return null;
	if (outcome.isError) return outcome.errorText;
	return typeof row?.content_text === "string" && row.content_text.length > 0 ? row.content_text : null;
}

export interface LeadScan {
	leads: Lead[];
	/** Lead records dropped by the maxLeads cap — counted, never silently lost. */
	truncatedLeads: number;
	/** Invocations whose result carried usable text (the honest denominator of extraction coverage). */
	resultsWithText: number;
}

/**
 * Extract leads from every tool result in the session and match each against
 * subsequent calls within the configured window. Pure and deterministic over
 * the message rows; leads come back in stream order.
 */
export function scanSessionLeads(
	messages: readonly MessageRow[],
	config: UncompletedLeadsConfig,
): LeadScan {
	const stream = buildToolStream([...messages]);
	const messagesById = new Map(messages.map((m) => [m.id, m]));

	interface Surfaced extends Lead {
		producerOrdinal: number;
	}

	const surfaced: Surfaced[] = [];
	let truncated = 0;
	let resultsWithText = 0;

	for (const inv of stream.invocations) {
		const text = resolvedResultText(inv, messagesById);
		if (text === null) continue;
		resultsWithText++;
		for (const raw of extractLeads(text, config)) {
			if (surfaced.length >= config.maxLeads) {
				truncated++;
				continue;
			}
			surfaced.push({
				type: raw.type,
				value: raw.value,
				source_message_id: inv.outcome!.messageId,
				tool_call_ordinal: inv.ordinal,
				status: "uncompleted",
				completed_by_message_id: null,
				producerOrdinal: inv.ordinal,
			});
		}
	}

	// Completion pass: for each lead, the first matching later invocation within
	// the window completes it. Strictly after the surfacing call, so a command's
	// own output mentioning the path it acted on never completes its own leads.
	for (const lead of surfaced) {
		for (const inv of stream.invocations) {
			if (inv.ordinal <= lead.producerOrdinal) continue;
			if (inv.ordinal > lead.producerOrdinal + config.completionWindow) break;
			if (matchesLead(lead.type, lead.value, inv)) {
				lead.status = "completed";
				lead.completed_by_message_id = inv.messageId;
				break;
			}
		}
	}

	const leads: Lead[] = surfaced.map(({ producerOrdinal: _producerOrdinal, ...lead }) => lead);
	return { leads, truncatedLeads: truncated, resultsWithText };
}

export { DEFAULT_UNCOMPLETED_LEADS_CONFIG };
