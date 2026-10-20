/**
 * The record of when a *background* tool call really finished (issue #306).
 *
 * A call the harness runs in the background — `run_in_background` Bash, a
 * `Workflow`, an `Agent` — returns at once. The transcript's tool result for it
 * is only an acknowledgement, so a timing analyzer that paired the call with
 * that result would measure the acknowledgement, not the work. The real end is
 * a separate `queue-operation` record: Claude Code writes
 *
 *     { "type": "queue-operation", "operation": "enqueue",
 *       "timestamp": "…", "content": "<task-notification>\n<task-id>…\n
 *       <tool-use-id>toolu_…\n<status>completed</status>\n…" }
 *
 * and the `<tool-use-id>` inside is the id of the tool call that was backgrounded.
 * Joining the two on that id gives the background task's true duration.
 *
 * This is a *host-emitted protocol*, not model output, so the parser reads it
 * here and stores the structure — exactly the trade the transcript parser
 * already makes for `stopReason`/`errorMessage`. Interpreting a status
 * ("completed" is not "succeeded") is an analyzer's job, not the ingest
 * layer's.
 *
 * The completion is stored in its own table, beside `messages`, because it is
 * not a message: it is not part of the conversation, it has no turn, and the
 * transcript's own line ordering puts it between two messages. A row per
 * (session, tool-call id) is the durable record; the call's own id is the join
 * key, and it is what makes a background call's duration recoverable after a
 * wipe and re-sync.
 */

import { Type, type Static } from "typebox";

/**
 * A `<task-notification>` block, as Claude Code writes it into a
 * `queue-operation` record's content.
 *
 * Every field is optional except the tool-use id: the harness writes several
 * shapes of notification, and a record that names no tool call is not a
 * completion of anything.
 */
export const TaskNotification = Type.Object({
	/** The harness's own id for the background task. */
	task_id: Type.Optional(Type.String()),
	/** The tool-call id of the call that was backgrounded. The join key. */
	tool_use_id: Type.String({ minLength: 1 }),
	/** Where the task's output was written. */
	output_file: Type.Optional(Type.String()),
	/**
	 * The harness's verdict: `completed`, `failed`, `killed`, `stopped`, … —
	 * recorded verbatim. Whether a "completed" task *succeeded* is a separate
	 * question, answered by the summary or the output, not by this word.
	 */
	status: Type.Optional(Type.String()),
	/** The harness's one-line summary of the task. */
	summary: Type.Optional(Type.String()),
});
export type TaskNotification = Static<typeof TaskNotification>;

/** The longest summary kept. A summary is a human-readable line, not a log. */
export const TASK_SUMMARY_CHARS = 300;

const TOOL_USE_ID = /<tool-use-id>([^<]*)<\/tool-use-id>/;
const TASK_ID = /<task-id>([^<]*)<\/task-id>/;
const OUTPUT_FILE = /<output-file>([^<]*)<\/output-file>/;
const STATUS = /<status>([^<]*)<\/status>/;
const SUMMARY = /<summary>([^<]*)<\/summary>/;

/**
 * Parse a `queue-operation` record's content into the notification it carries.
 *
 * Returns null when the content names no tool-use id: the harness also writes
 * `queue-operation` records for other things (an enqueued prompt, a
 * dequeue), and those are not a background task's completion.
 */
export function parseTaskNotification(content: string | null | undefined): TaskNotification | null {
	if (!content) return null;
	if (!content.includes("<tool-use-id>")) return null;

	const toolUseId = TOOL_USE_ID.exec(content)?.[1]?.trim() ?? "";
	if (!toolUseId) return null;

	const summary = SUMMARY.exec(content)?.[1]?.trim();
	return {
		task_id: TASK_ID.exec(content)?.[1]?.trim(),
		tool_use_id: toolUseId,
		output_file: OUTPUT_FILE.exec(content)?.[1]?.trim(),
		status: STATUS.exec(content)?.[1]?.trim(),
		summary: summary ? summary.slice(0, TASK_SUMMARY_CHARS) : undefined,
	};
}

/**
 * A background task's completion, as stored.
 *
 * `completed_at` is the instant the harness recorded the notification, and it
 * is what a duration is measured against. `status` is the harness's own
 * verdict, verbatim.
 */
export interface BackgroundTaskInsert {
	session_id: string;
	/** The tool-call id of the backgrounded call. The join key. */
	tool_use_id: string;
	/** The harness's task id, when it recorded one. */
	task_id: string | null;
	/** When the harness recorded the completion. */
	completed_at: string;
	/** The harness's verdict, verbatim: completed | failed | killed | … */
	status: string | null;
	/** The harness's one-line summary, bounded. */
	summary: string | null;
}

/**
 * Extract the background-task completions from a Claude session's lines.
 *
 * Only `operation: "enqueue"` counts: that is the record the harness writes
 * when a background task finishes and its notification is queued for the agent.
 * The other operations (`remove`, `dequeue`) restate or withdraw the same
 * notification, so counting them would report one task twice.
 */
export function extractBackgroundTasks(lines: readonly string[], sessionId: string): BackgroundTaskInsert[] {
	const out: BackgroundTaskInsert[] = [];
	for (const line of lines) {
		if (!line.includes("queue-operation")) continue;
		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (obj["type"] !== "queue-operation") continue;
		if (obj["operation"] !== "enqueue") continue;

		const content = typeof obj["content"] === "string" ? obj["content"] : null;
		const notification = parseTaskNotification(content);
		if (!notification) continue;

		const timestamp = typeof obj["timestamp"] === "string" ? obj["timestamp"] : null;
		if (!timestamp) continue;

		out.push({
			session_id: sessionId,
			tool_use_id: notification.tool_use_id,
			task_id: notification.task_id ?? null,
			completed_at: timestamp,
			status: notification.status ?? null,
			summary: notification.summary ?? null,
		});
	}
	return out;
}
