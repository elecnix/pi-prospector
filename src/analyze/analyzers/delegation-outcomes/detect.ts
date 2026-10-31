/**
 * Delegation outcomes: how each hand-off to a child agent ended.
 *
 * A **delegation** is a call to a tool that hands work to a child agent. How it
 * ended is read from what the host recorded, in this order:
 *
 *   1. no result ever arrived: `unanswered`. The parent abandoned the wait or
 *      the session ended first.
 *   2. a background completion record for the call: its status decides
 *      (`failed`, `killed`, `completed`). This is the host's own word on the
 *      end of work the call only acknowledged.
 *   3. the host flagged the result as an error: `failed`.
 *   4. Pi's orchestration classification: `child_failed` is `failed`, and
 *      `revived` is `revived`, a call that resumed an earlier run.
 *   5. otherwise `completed`.
 *
 * `completed` means the host reported no failure. It does not say the child's
 * work was right.
 */

import type { BackgroundTaskRow, MessageRow } from "../../types.js";
import { buildToolStream } from "../../tool-stream.js";
import { DEFAULT_DELEGATION_OUTCOMES_CONFIG, type DelegationOutcomesConfig } from "./config.js";

export type DelegationOutcome = "completed" | "failed" | "killed" | "revived" | "unanswered" | "other";

export interface DelegationEvent {
	tool: string;
	/** The child agent's type when the call named one (`subagent_type` or `agent`), else null. */
	agent: string | null;
	outcome: DelegationOutcome;
	/** Whether the call ran the child in the background. */
	background: boolean;
	call_message_id: string;
}

export interface DelegationScan {
	events: DelegationEvent[];
	/** Every delegation call, including those past the event cap. */
	call_count: number;
	counts: Record<DelegationOutcome, number>;
	/** Every tool call in the session: the denominator for a delegation share. */
	tool_call_count: number;
}

const OUTCOMES: readonly DelegationOutcome[] = ["completed", "failed", "killed", "revived", "unanswered", "other"];

function str(args: Record<string, unknown>, key: string): string | null {
	const v = args[key];
	return typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 80) : null;
}

/** How each delegation call in a session ended. */
export function scanDelegations(
	messages: MessageRow[],
	backgroundTasks: readonly BackgroundTaskRow[],
	config: DelegationOutcomesConfig = DEFAULT_DELEGATION_OUTCOMES_CONFIG,
): DelegationScan {
	const tools = new Set(config.delegationToolNames.map((n) => n.toLowerCase()));
	const failed = new Set(config.failedBackgroundStatuses.map((s) => s.toLowerCase()));
	const killed = new Set(config.killedBackgroundStatuses.map((s) => s.toLowerCase()));
	const background = new Map(backgroundTasks.map((t) => [t.tool_use_id, (t.status ?? "").toLowerCase()]));

	const { invocations } = buildToolStream(messages);
	const events: DelegationEvent[] = [];
	const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<DelegationOutcome, number>;
	let callCount = 0;
	for (const call of invocations) {
		if (!tools.has(call.name.toLowerCase())) continue;
		callCount++;

		const done = background.get(call.callId);
		let outcome: DelegationOutcome;
		if (call.outcome === null) outcome = "unanswered";
		else if (done !== undefined) outcome = failed.has(done) ? "failed" : killed.has(done) ? "killed" : done === "completed" ? "completed" : "other";
		else if (call.outcome.isError) outcome = "failed";
		else if (call.outcome.subagent?.status === "child_failed") outcome = "failed";
		else if (call.outcome.subagent?.status === "revived") outcome = "revived";
		else outcome = "completed";
		counts[outcome]++;

		if (events.length < config.maxEvents) {
			events.push({
				tool: call.name,
				agent: str(call.args, "subagent_type") ?? str(call.args, "agent"),
				outcome,
				background: call.args["run_in_background"] === true || done !== undefined,
				call_message_id: call.messageId,
			});
		}
	}
	return { events, call_count: callCount, counts, tool_call_count: invocations.length };
}
