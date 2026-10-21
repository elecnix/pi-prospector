/**
 * Background task completions, joined to the calls that were backgrounded
 * (issue #306).
 *
 * A call the harness runs in the background — `run_in_background` Bash, a
 * `Workflow`, an `Agent` — returns at once. The transcript's tool result for
 * it is an acknowledgement, not the end of the work, so pairing the call with
 * that result would measure the acknowledgement. The real end is a separate
 * record: a `queue-operation` the harness writes when the task finishes,
 * naming the backgrounded call's tool-use id. Sync ingests those into
 * `background_tasks`; this module joins them back onto the calls.
 *
 * The join is by tool-use id — the provider's own id for the call — so it is
 * exact, never positional. A call with no completion record is **untimed
 * background**: the work's end was never recorded, and reading it as
 * near-instant would be the same lie as reading a missing timestamp as zero.
 */

import type { BackgroundTaskRow } from "../../types.js";

/**
 * Index a session's background-task completions by the tool-use id they name.
 *
 * A tool-use id appears at most once per session — the table's key is
 * (session, tool_use_id) — so the map is one-to-one. A completion for a call
 * this session never made is kept in the map but never joins to anything: it
 * is a record of a call the session does not contain, and the caller's lookup
 * by id simply will not find it.
 */
export function indexBackgroundTasks(rows: readonly BackgroundTaskRow[]): Map<string, BackgroundTaskRow> {
	const byToolUseId = new Map<string, BackgroundTaskRow>();
	for (const row of rows) {
		if (!byToolUseId.has(row.tool_use_id)) byToolUseId.set(row.tool_use_id, row);
	}
	return byToolUseId;
}

/**
 * The instant a completion record was written, or null when it carries none.
 * An unparseable timestamp is a missing timestamp, not the epoch.
 */
export function completionTime(row: BackgroundTaskRow): number | null {
	const ms = Date.parse(row.completed_at);
	return Number.isNaN(ms) ? null : ms;
}

/**
 * Whether a tool call was run in the background.
 *
 * The host marks it in the call's own arguments: `run_in_background: true` for
 * a shell call, and the same flag on an `Agent` or `Workflow` call. A call
 * that carries the flag returned at once, so its transcript result is an
 * acknowledgement — whatever the host later recorded, or did not, about the
 * work.
 *
 * The flag is what distinguishes a backgrounded call whose completion was
 * never recorded from an ordinary call. Without it, such a call would fall
 * through to the ordinary timing path and be measured by its acknowledgement,
 * which is the near-instant reading this whole mechanism exists to remove.
 */
export function isBackgroundCall(args: Record<string, unknown>): boolean {
	return args["run_in_background"] === true || args["runInBackground"] === true;
}
