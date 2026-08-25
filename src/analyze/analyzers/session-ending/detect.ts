/**
 * Deterministic ending-label classification for session-ending (issue #102).
 *
 * One label per session, decided by rules over the ordered transcript tail and
 * the shared action stream (`src/analyze/tool-stream.ts`) — no LLM. The
 * taxonomy is deliberately small and evidence-based, with `unclear` as the
 * honest conservative default, because a read of someone's terminal history
 * cannot know whether work finished in another session or why a quiet ending
 * went quiet (DESIGN.md, *Failure analysis*: coverage beats assumption).
 *
 * Labels and their detection rules, in evaluation order — the first rule whose
 * evidence matches decides:
 *
 *   **errored** — the final recorded events are failures: the last assistant
 *   generation carries a host error (`error_message`, or `stop_reason =
 *   'error'`), or the session ends on a tool-result row flagged as an error.
 *
 *   **abandoned** — the session ends incomplete: the operator aborted the last
 *   generation (`stop_reason = 'aborted'`); the transcript ends on a successful
 *   tool result nobody synthesised into an answer; it ends on a non-closing
 *   user message the agent never replied to; or it ends on an assistant step
 *   still issuing tool calls (cut off mid-work). A session that ends on an
 *   agent turn nobody followed up is the issue's proxy for walking away.
 *
 *   **handed-off** — the final message is a short explicit user closure
 *   ("thanks", "that's all"): the exchange ended deliberately.
 *
 *   **resolved** — the agent delivered a substantive final summary and the most
 *   recent verification-class tool call (tests, build, commit, push — see
 *   config patterns) succeeded; or, with no verification-class call, the last
 *   recorded tool outcome succeeded. The wrap-up plus a green exit is the only
 *   combination this analyzer trusts enough to call resolved.
 *
 *   **unclear** — everything else: pure conversation with no outcome evidence,
 *   a wrap-up delivered right after a failing verification, no usable final
 *   text, or a non-conversational final row. Generous by design — the issue's
 *   ranking needs a coarse label, and a wrong confident one is worse than an
 *   honest shrug.
 *
 * The label must weight ranking only, never gate detection: consumers join this
 * node's label to a session's proposals at synthesis/display time. Nothing
 * here makes a session more or less analysed.
 */

import { Type, type Static } from "typebox";
import type { MessageRow } from "../../types.js";
import {
	buildToolStream,
	type ToolInvocation,
	type ToolStream,
} from "../../tool-stream.js";
import type { SessionEndingConfig } from "./config.js";

/** The coarse ending labels. Small, evidence-based, `unclear` by default. */
export const EndingLabelSchema = Type.Union([
	Type.Literal("resolved"),
	Type.Literal("abandoned"),
	Type.Literal("handed-off"),
	Type.Literal("errored"),
	Type.Literal("unclear"),
]);
export type EndingLabel = Static<typeof EndingLabelSchema>;

/**
 * What the classification observed. The excerpt is provenance for the human
 * reading the node, capped at `excerptLength`; the verification fields name
 * which config pattern matched the last verification-class call (pattern text,
 * not raw command text — commands can quote secrets and the graph is durable
 * and widely readable). `verification_ok` is null whenever nothing
 * verification-class was found; a missing flag is never read as success.
 */
export const EndingEvidenceSchema = Type.Object({
	final_message_id: Type.String(),
	final_role: Type.String(),
	/** Fixed code of the detection rule that fired — the catalogue, not free text. */
	rule: Type.String(),
	/** Truncated excerpt of the last assistant message, or null when none carried text. */
	final_assistant_excerpt: Type.Union([Type.String(), Type.Null()]),
	verification_found: Type.Boolean(),
	verification_ok: Type.Union([Type.Boolean(), Type.Null()]),
	verification_pattern: Type.Union([Type.String(), Type.Null()]),
});
export type EndingEvidence = Static<typeof EndingEvidenceSchema>;

export const SessionEndingScanSchema = Type.Object({
	label: EndingLabelSchema,
	evidence: EndingEvidenceSchema,
	unresolved_tool_call_count: Type.Number(),
	tool_call_count: Type.Number(),
	/**
	 * Whether any assistant row carries a `stop_reason`. False means the rows
	 * predate stop-reason capture, so "the last generation looks healthy" is
	 * weaker evidence than it reads — surfaced so consumers can discount the
	 * label rather than assume coverage.
	 */
	stop_reason_recorded: Type.Boolean(),
});
export type SessionEndingScan = Static<typeof SessionEndingScanSchema>;

/** Whether an assistant row records a failed generation (`aborted` excluded — it is the operator stopping, not a defect). */
function isGenerationFailure(m: MessageRow): boolean {
	if (m.error_message) return true;
	return m.stop_reason === "error";
}

/** Match a short closing utterance against the configured closure cues. */
function matchesClosure(text: string, config: SessionEndingConfig): boolean {
	const trimmed = text.trim();
	if (trimmed.length === 0 || trimmed.length > config.maxClosureLength) return false;
	return config.closurePatterns.some((p) => new RegExp(p, "i").test(trimmed));
}

/** The shell command a shell-tool invocation asked for, or null. */
function shellCommand(inv: ToolInvocation, config: SessionEndingConfig): string | null {
	if (!config.shellToolNames.includes(inv.name)) return null;
	const cmd = inv.args["command"];
	return typeof cmd === "string" ? cmd : null;
}

/**
 * Find the last verification-class invocation that ever received its result.
 * Unpaired calls are skipped here: they are evidence of truncation (handled by
 * the mid-work rules via the final message), not of an exit status.
 */
function lastVerification(stream: ToolStream, config: SessionEndingConfig):
	{ invocation: ToolInvocation; pattern: string; ok: boolean } | null {
	for (let i = stream.invocations.length - 1; i >= 0; i--) {
		const inv = stream.invocations[i]!;
		if (!inv.outcome) continue;
		const cmd = shellCommand(inv, config);
		if (cmd === null) continue;
		for (const p of config.verificationPatterns) {
			if (new RegExp(p, "i").test(cmd.trim())) {
				return { invocation: inv, pattern: p, ok: !inv.outcome.isError };
			}
		}
	}
	return null;
}

/** The last invocation that received any result, or null. */
function lastResolvedOutcome(stream: ToolStream): { invocation: ToolInvocation; ok: boolean } | null {
	for (let i = stream.invocations.length - 1; i >= 0; i--) {
		const inv = stream.invocations[i]!;
		if (!inv.outcome) continue;
		return { invocation: inv, ok: !inv.outcome.isError };
	}
	return null;
}

function lastAssistantText(messages: readonly MessageRow[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "assistant") continue;
		const text = m.content_text ?? "";
		if (text.trim().length > 0) return text;
	}
	return null;
}

/**
 * Classify how a session ended. Returns null only for an empty transcript —
 * every non-empty session ends somehow, so every one gets a label.
 */
export function classifyEnding(
	messages: readonly MessageRow[],
	config: SessionEndingConfig,
): SessionEndingScan | null {
	if (messages.length === 0) return null;

	const stream = buildToolStream([...messages]);
	const last = messages[messages.length - 1]!;
	const unresolvedToolCallCount = stream.invocations.filter((inv) => !inv.outcome).length;
	const excerptSource = lastAssistantText(messages);
	const excerpt = excerptSource === null ? null : excerptSource.slice(0, config.excerptLength);

	let label: EndingLabel;
	let rule: string;

	if (last.role === "assistant") {
		if (last.stop_reason === "aborted") {
			label = "abandoned";
			rule = "operator_abort_at_end";
		} else if (isGenerationFailure(last)) {
			label = "errored";
			rule = "generation_failure_at_end";
		} else if (last.tool_calls !== null && last.tool_calls !== "") {
			// Nothing follows this step, so its calls were never answered: the
			// transcript stops while the agent was still working.
			label = "abandoned";
			rule = "cut_off_mid_work";
		} else {
			const summaryLength = (last.content_text ?? "").trim().length;
			if (summaryLength < config.minFinalSummaryLength) {
				label = "unclear";
				rule = "insufficient_final_text";
			} else {
				const verification = lastVerification(stream, config);
				if (verification !== null) {
					if (verification.ok) {
						label = "resolved";
						rule = "verification_passed";
					} else {
						label = "unclear";
						rule = "wrap_up_after_failed_verification";
					}
				} else {
					const lastOut = lastResolvedOutcome(stream);
					if (lastOut === null) {
						label = stream.invocations.length > 0 ? "abandoned" : "unclear";
						rule = stream.invocations.length > 0 ? "no_recorded_results" : "no_outcome_evidence";
					} else if (lastOut.ok) {
						label = "resolved";
						rule = "summary_after_success";
					} else {
						label = "unclear";
						rule = "summary_after_failure";
					}
				}
			}
		}
	} else if (last.role === "toolResult") {
		// Read the final row's outcomes through the shared action stream rather
		// than re-parsing its tool_results blob, so what "the last result failed"
		// means is exactly what every other analyzer sees.
		const anyError = stream.invocations.some(
			(inv) => inv.outcome !== null && inv.outcome.messageId === last.id && inv.outcome.isError,
		);
		if (anyError) {
			label = "errored";
			rule = "failed_result_at_end";
		} else {
			label = "abandoned";
			rule = "unanswered_result_at_end";
		}
	} else if (last.role === "user") {
		const text = last.content_text ?? "";
		if (matchesClosure(text, config)) {
			label = "handed-off";
			rule = "explicit_closure";
		} else {
			label = "abandoned";
			rule = "unanswered_user_message";
		}
	} else {
		// Compaction summaries, branch summaries, anything else: not a
		// conversational ending anyone defined, so the honest default applies.
		label = "unclear";
		rule = "non_conversational_end";
	}

	const verification = lastVerification(stream, config);
	return {
		label,
		evidence: {
			final_message_id: last.id,
			final_role: last.role,
			rule,
			final_assistant_excerpt: excerpt,
			verification_found: verification !== null,
			verification_ok: verification === null ? null : verification.ok,
			verification_pattern: verification === null ? null : verification.pattern,
		},
		unresolved_tool_call_count: unresolvedToolCallCount,
		tool_call_count: stream.invocations.length,
		stop_reason_recorded: stream.coverage.stopReasonRecorded,
	};
}
