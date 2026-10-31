import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_CALL_ID } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "session-ending.ending-label",
		name: "Session ending label",
		definition: "How a session stopped, reduced to one of five values by rules over the last events of its transcript.",
		measurement: "rule-based",
		unit: "sessions per label",
		denominator: "labelled sessions: every session with at least one message, child sessions included",
		values: [
			{ value: "errored", meaning: "The last recorded events are failures: the last generation has a host error, or the session ends on a failed tool result." },
			{ value: "abandoned", meaning: "The transcript stops with work unfinished: the operator aborted the last generation, a tool result was never answered, a user message got no reply, or the last step still issues tool calls." },
			{ value: "handed-off", meaning: "The last message is a short closure from the user, such as \"thanks\"." },
			{ value: "resolved", meaning: "The agent wrote a substantive final summary and the most recent verification-class command succeeded, or, with no such command, the last tool result succeeded." },
			{ value: "unclear", meaning: "Everything else. This is the default when the evidence does not support a stronger label." },
		],
		limitations: [
			"The label is coarse and ranks only. It cannot see a merge, and work that finished in another session reads as unfinished.",
			"Session ending is defined for child sessions too, and a child session ends cleanly more often than a top-level one, so a mixed denominator inflates resolved. Filter to top-level sessions with `parent_session IS NULL` on the sessions table when the question is about the person's own sessions.",
			"A verification pattern matches the start of the command, so a test run behind `cd dir &&` or an environment assignment goes unrecognised and the label falls back to the last tool result.",
			"A session that ends on a record that is not a conversation turn, such as a compaction summary or a bash execution, gets unclear, and that can be a large share.",
			LIMIT_CALL_ID,
		],
		seriesBreaks: [
			{
				version: "1.1",
				effect: "The action stream pairs results with id-less stored calls. Before it, those sessions ended abandoned by `no_recorded_results` and none could reach resolved.",
				repair: "prospect analyze --analyzer session-ending --revise minor",
			},
		],
	},
	{
		id: "session-ending.ending-rule",
		name: "Session ending rule",
		definition: "The code of the rule that decided an ending label, stored on the node as evidence.",
		measurement: "rule-based",
		unit: "sessions per rule",
		denominator: "labelled sessions",
		values: [
			{ value: "operator_abort_at_end", meaning: "abandoned: the operator aborted the last generation." },
			{ value: "generation_failure_at_end", meaning: "errored: the last generation has a host error." },
			{ value: "cut_off_mid_work", meaning: "abandoned: the last assistant step still issues tool calls." },
			{ value: "insufficient_final_text", meaning: "unclear: the final text is shorter than the configured minimum." },
			{ value: "verification_passed", meaning: "resolved: the most recent verification-class command succeeded." },
			{ value: "wrap_up_after_failed_verification", meaning: "unclear: the most recent verification-class command failed." },
			{ value: "summary_after_success", meaning: "resolved: no verification command ran and the last tool result succeeded." },
			{ value: "summary_after_failure", meaning: "unclear: no verification command ran and the last tool result failed." },
			{ value: "no_recorded_results", meaning: "abandoned: calls exist and none has a result." },
			{ value: "no_outcome_evidence", meaning: "unclear: the session made no calls." },
			{ value: "failed_result_at_end", meaning: "errored: the last record is a failed tool result." },
			{ value: "unanswered_result_at_end", meaning: "abandoned: the last record is a tool result nobody answered." },
			{ value: "explicit_closure", meaning: "handed-off: the last record is a short user closure." },
			{ value: "unanswered_user_message", meaning: "abandoned: the last record is a user message the agent never replied to." },
			{ value: "non_conversational_end", meaning: "unclear: the last record is not a conversation turn." },
		],
		limitations: [
			"When the last record is from the assistant, the rules run in the order listed from operator_abort_at_end to no_outcome_evidence, and the first match decides. The rule code explains a label and is not a second measurement.",
			LIMIT_CALL_ID,
		],
	},
];
