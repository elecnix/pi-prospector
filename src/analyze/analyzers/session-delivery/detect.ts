/**
 * Delivery detection for session-delivery.
 *
 * A **delivery event** is a shell command that moved work toward the remote or
 * into the main line, and that the host reported as having succeeded: a commit,
 * a push, or a pull request merge. Opening a pull request is `pr-opened`'s
 * finding and is not repeated here.
 *
 * The command is read as a command, not as text: heredoc bodies and quoted
 * strings are removed first, so `echo "git commit"` delivers nothing. Dry runs
 * deliver nothing. `gh pr merge --auto` only arms a merge for later, and `--disable-auto` cancels one, so it is
 * not a merge.
 *
 * A success the host reported is checked once more against the result text when
 * the result row holds exactly one result. git exits 0 for some refusals, and a
 * pipe (`git commit … | tail`) returns the pipe's status, so the text is the
 * only evidence of a commit that did not happen.
 */

import type { MessageRow } from "../../types.js";
import { buildToolStream } from "../../tool-stream.js";
import { commandSegments, gitSubcommand, stripCommandText } from "../time-economy/spans.js";
import { commandFamily } from "../time-economy/detect.js";
import { DEFAULT_SESSION_DELIVERY_CONFIG, type SessionDeliveryConfig } from "./config.js";

export type DeliveryKind = "commit" | "push" | "pr_merge";

export interface DeliveryEvent {
	kind: DeliveryKind;
	/** Whether the call succeeded: the host said so and the result text did not say otherwise. */
	succeeded: boolean;
	/**
	 * Whether the result text was read to confirm the host's verdict. False when the
	 * call went unanswered, or when its result row held several results and the
	 * joined text cannot be attributed to one; the host's verdict then stands alone.
	 */
	result_checked: boolean;
	/** The call's timestamp, or null when the transcript recorded none. */
	at: string | null;
	call_message_id: string;
	/** The message that carried the result, or null when the call was never answered. */
	result_message_id: string | null;
}

/** The delivery kinds a shell command runs, one entry per segment that delivers. */
export function deliveryKindsOf(command: string): DeliveryKind[] {
	const kinds: DeliveryKind[] = [];
	for (const segment of commandSegments(stripCommandText(command, "_"))) {
		// The program must sit at command position: `echo git commit` and
		// `grep -l git push` mention a command without running it.
		const program = commandFamily(segment, 1);
		const sub = program === "git" ? gitSubcommand(segment) : null;
		// `-n` is a dry run for push but `--no-verify` for commit.
		if (/\s--dry-run\b/.test(segment) || (sub === "push" && /\s-[a-zA-Z]*n[a-zA-Z]*(\s|$)/.test(segment))) continue;
		if (sub === "commit") kinds.push("commit");
		else if (sub === "push") kinds.push("push");
		else if (commandFamily(segment, 3) === "gh pr merge" && !/\s--(auto|disable-auto|merge-queue)\b/.test(segment)) kinds.push("pr_merge");
	}
	return kinds;
}

function markersFor(kind: DeliveryKind, config: SessionDeliveryConfig): RegExp[] {
	const sources =
		kind === "commit" ? config.commitFailureMarkers : kind === "push" ? config.pushFailureMarkers : config.mergeFailureMarkers;
	return sources.map((s) => {
		try {
			return new RegExp(s, "im");
		} catch (err) {
			throw new Error(`session-delivery: invalid failure marker "${s}": ${err instanceof Error ? err.message : String(err)}`);
		}
	});
}

/** The delivery events of a session, in stream order. */
export function findDeliveryEvents(
	messages: MessageRow[],
	config: SessionDeliveryConfig = DEFAULT_SESSION_DELIVERY_CONFIG,
): DeliveryEvent[] {
	const shell = new Set(config.shellToolNames.map((n) => n.toLowerCase()));
	const byId = new Map(messages.map((m) => [m.id, m]));
	const events: DeliveryEvent[] = [];
	for (const call of buildToolStream(messages).invocations) {
		if (!shell.has(call.name.toLowerCase())) continue;
		const command = call.args["command"];
		if (typeof command !== "string") continue;
		for (const kind of deliveryKindsOf(command)) {
			const outcome = call.outcome;
			let succeeded = outcome !== null && !outcome.isError;
			let checked = false;
			if (succeeded && outcome) {
				const row = byId.get(outcome.messageId);
				checked = row?.tool_results ? safeCount(row.tool_results) === 1 : false;
				const text = checked ? (row?.content_text ?? "").slice(0, config.maxResultChars) : "";
				if (markersFor(kind, config).some((re) => re.test(text))) succeeded = false;
			}
			events.push({
				kind,
				succeeded,
				result_checked: checked,
				at: byId.get(call.messageId)?.timestamp ?? null,
				call_message_id: call.messageId,
				result_message_id: outcome?.messageId ?? null,
			});
		}
	}
	return events;
}

function safeCount(toolResults: string): number {
	try {
		const parsed: unknown = JSON.parse(toolResults);
		return Array.isArray(parsed) ? parsed.length : 0;
	} catch {
		return 0;
	}
}
