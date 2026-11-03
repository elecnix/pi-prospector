/**
 * Git command detection for git-commands.
 *
 * A **git command event** is a shell command that commits, pushes, or merges a
 * pull request, with the host's verdict on whether it worked. Opening a pull
 * request is `pr-opened`'s record and is not repeated here.
 *
 * The command is read as a command, not as text: heredoc bodies and quoted
 * strings are removed first, so `echo "git commit"` runs nothing, and the
 * program must sit at command position. A dry run is no event. `gh pr merge
 * --auto` only arms a merge for later and `--disable-auto` cancels one, so
 * neither is a merge.
 *
 * A success the host reported is checked against the result text when the
 * result row holds exactly one result. git exits 0 for some refusals, and a pipe
 * (`git commit … | tail`) returns the pipe's status, so the text is the only
 * evidence of a commit that did not happen.
 */

import type { MessageRow } from "../../types.js";
import { buildToolStream } from "../../tool-stream.js";
import { commandSegments, gitSubcommand, stripCommandText } from "../time-economy/spans.js";
import { commandFamily } from "../time-economy/detect.js";
import { DEFAULT_GIT_COMMANDS_CONFIG, type GitCommandsConfig } from "./config.js";

export type GitCommandKind = "commit" | "push" | "pr_merge";

export interface GitCommandEvent {
	kind: GitCommandKind;
	/**
	 * True when the host reported the call failed and the call chained several
	 * commands (`&&`, `;`, a pipe, or lines). The host's verdict covers the whole call and
	 * cannot say which command failed, or whether the later ones ever ran, so
	 * this event's failure is not attributed to it.
	 */
	verdict_shared: boolean;
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

/** The git command kinds a shell command runs, one entry per segment. */
export function gitCommandKindsOf(command: string): GitCommandKind[] {
	const kinds: GitCommandKind[] = [];
	for (const segment of commandSegments(stripCommandText(command, "_"))) {
		// The program must sit at command position: `echo git commit` and
		// `grep -l git push` mention a command without running it.
		const program = commandFamily(segment, 1);
		const sub = program === "git" ? gitSubcommand(segment) : null;
		// `-n` is a dry run for push but `--no-verify` for commit.
		// Help prints usage and exits 0, so it must not read as a command that worked.
		if (/\s(?:--help|-h)(?:\s|$)/.test(segment)) continue;
		if (/\s--dry-run\b/.test(segment) || (sub === "push" && /\s-[a-zA-Z]*n[a-zA-Z]*(\s|$)/.test(segment))) continue;
		if (sub === "commit") kinds.push("commit");
		else if (sub === "push") kinds.push("push");
		else if (commandFamily(segment, 3) === "gh pr merge" && !/\s--(auto|disable-auto|merge-queue)\b/.test(segment)) kinds.push("pr_merge");
	}
	return kinds;
}

function markersFor(kind: GitCommandKind, config: GitCommandsConfig): RegExp[] {
	const sources =
		kind === "commit" ? config.commitFailureMarkers : kind === "push" ? config.pushFailureMarkers : config.mergeFailureMarkers;
	return sources.map((s) => {
		try {
			return new RegExp(s, "im");
		} catch (err) {
			throw new Error(`git-commands: invalid failure marker "${s}": ${err instanceof Error ? err.message : String(err)}`);
		}
	});
}

/** The git command events of a session, in stream order. */
export function findGitCommandEvents(
	messages: MessageRow[],
	config: GitCommandsConfig = DEFAULT_GIT_COMMANDS_CONFIG,
): GitCommandEvent[] {
	const shell = new Set(config.shellToolNames.map((n) => n.toLowerCase()));
	const byId = new Map(messages.map((m) => [m.id, m]));
	const events: GitCommandEvent[] = [];
	for (const call of buildToolStream(messages).invocations) {
		if (!shell.has(call.name.toLowerCase())) continue;
		const command = call.args["command"];
		if (typeof command !== "string") continue;
		for (const kind of gitCommandKindsOf(command)) {
			const outcome = call.outcome;
			let succeeded = outcome !== null && !outcome.isError;
			let checked = false;
			if (succeeded && outcome) {
				const row = byId.get(outcome.messageId);
				checked = row?.tool_results ? safeCount(row.tool_results) === 1 : false;
				const text = checked ? headAndTail(row?.content_text ?? "", config.maxResultChars) : "";
				if (markersFor(kind, config).some((re) => re.test(text))) succeeded = false;
			}
			const hostFailed = outcome !== null && outcome.isError;
			events.push({
				kind,
				verdict_shared: hostFailed && /&&|\||;|\n/.test(stripCommandText(command.trim(), "_")),
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

/** The text, or its head and tail when it is longer than the cap: a refusal prints last. */
function headAndTail(text: string, cap: number): string {
	if (text.length <= cap) return text;
	const half = Math.floor(cap / 2);
	return `${text.slice(0, half)}\n${text.slice(text.length - half)}`;
}

function safeCount(toolResults: string): number {
	try {
		const parsed: unknown = JSON.parse(toolResults);
		return Array.isArray(parsed) ? parsed.length : 0;
	} catch {
		return 0;
	}
}
