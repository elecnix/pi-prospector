import type { ToolErrorClass } from "../types.js";

/**
 * Ordered error signatures. First match wins, so a policy refusal is tested
 * ahead of everything else: it quotes the command it blocked, and that quote
 * routinely contains wording another pattern would claim.
 *
 * Every pattern here was taken from a measured failure, never imagined — a
 * detector built from the examples you happen to have met finds those examples
 * again and nothing else.
 */
const TOOL_ERROR_SIGNATURES: ReadonlyArray<readonly [ToolErrorClass, RegExp]> = [
	["policy_blocked", /^\s*(?:<tool_use_error>)?\s*Blocked:|refused by policy|denied by the .* classifier/i],
	["edits_overlap", /\bedits\[\d+\] and edits\[\d+\] overlap\b/i],
	// No \b after the bracket: `]` followed by a space is not a word boundary,
	// so the indexed form would never match.
	["anchor_not_found", /Could not find (?:the exact text|edits\[\d+\])|oldText must match exactly/i],
	["input_invalid", /Validation failed for tool\b|InputValidationError|Input validation error/i],
	["shell_syntax", /unexpected EOF while looking for matching|syntax error near unexpected token/i],
	["script_error", /Traceback \(most recent call last\)|^\s*\w*Error: .*\n\s+at /im],
	["not_found", /No such file or directory|\bENOENT\b|not found in\b/i],
	["timeout", /\btimed out\b|\bETIMEDOUT\b/i],
];

/**
 * Name the cause of a failed tool call, from the result text that ingestion
 * then discards.
 *
 * The same trade as `classifySubagentResult` directly above, for the same
 * reason: the cause of a failure lives only in the discarded text, so without
 * a classification here a downstream analyzer can see *that* an edit failed and
 * how long the message was, never *why*. It cannot recover the difference
 * later — the text is gone by the time any analyzer runs.
 *
 * Unlike the subagent outcome this keeps NO excerpt. A subagent result is a
 * host-emitted status line; an arbitrary tool error is whatever the tool
 * printed, which may be a chunk of the file, a token or a customer prompt.
 *
 * A failure this cannot name returns "unclassified" rather than undefined, so
 * "no classifier ran" and "ran and matched nothing" stay distinguishable. That
 * distinction is the whole point of the field: a waiter that cannot tell
 * "not yet" from "never" is the bug this data is meant to find.
 */
export function classifyToolError(isError: boolean, text: string | null): ToolErrorClass | undefined {
	if (!isError) return undefined;
	if (!text) return "unclassified";
	for (const [cls, re] of TOOL_ERROR_SIGNATURES) {
		if (re.test(text)) return cls;
	}
	return "unclassified";
}
