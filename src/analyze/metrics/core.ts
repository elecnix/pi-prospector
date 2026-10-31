/**
 * Metrics counted straight from the index, with no analyzer behind them.
 *
 * They belong to the pseudo-owner `sessions`. Their values come from the sessions
 * and messages tables, so they are always `counted`.
 */

import { CORE_OWNER, type MetricDefinition } from "./types.js";
import { LIMIT_HARNESS, LIMIT_PARALLEL, LIMIT_USER_ROLE } from "./limits.js";

export const CORE_METRICS: MetricDefinition[] = [
	{
		id: `${CORE_OWNER}.count`,
		name: "Sessions and child sessions",
		definition: "The number of recorded sessions. A top-level session has no parent session, and a child session is a sub-agent or workflow run that a parent started.",
		measurement: "counted",
		unit: "sessions",
		denominator: "none",
		limitations: [
			"A session of a few steps counts the same as a long one. To count working sessions only, a report sets its own floor.",
			"A child session exists only where the harness or an extension writes its transcript to a place the sync layer reads.",
			"A report says whether it counts all sessions or top-level sessions only.",
		],
	},
	{
		id: `${CORE_OWNER}.sessions-by-source`,
		name: "Share of sessions by harness",
		definition: "The share of sessions whose source is pi, claude, codex, opencode, cline or unknown.",
		measurement: "counted",
		unit: "percent of sessions",
		denominator: "sessions in the period",
		limitations: [
			"The source is the store where sync found the session, so a copied session keeps the source of the store it was found in.",
			LIMIT_HARNESS,
		],
	},
	{
		id: `${CORE_OWNER}.active-days`,
		name: "Active days",
		definition: "The number of distinct UTC days on which a session started.",
		measurement: "counted",
		unit: "days",
		denominator: "none",
		limitations: [
			"A local day can fall on another date than the UTC day, so a report in local time says which zone it assumed.",
			"A day with a session started by an unattended agent counts as active. The figure shows when the machine worked and says nothing about when the person did.",
		],
	},
	{
		id: `${CORE_OWNER}.duration`,
		name: "Session duration",
		definition: "Wall-clock time from a session's first message to its last.",
		measurement: "counted",
		unit: "minutes per session",
		denominator: "none",
		limitations: [
			"It includes every pause, so a session left open overnight is long. Active time measures the time the agent or the person worked.",
		],
	},
	{
		id: `${CORE_OWNER}.prompts-per-session`,
		name: "Prompts per session",
		definition: "The number of user-role messages in a session.",
		measurement: "counted",
		unit: "messages per session",
		denominator: "sessions",
		limitations: [
			LIMIT_USER_ROLE,
			"Pi files its own injected notifications under another role, so Pi's count sits closer to what a person typed than Claude Code's does.",
			LIMIT_HARNESS,
		],
	},
	{
		id: `${CORE_OWNER}.tool-calls-per-session`,
		name: "Tool calls per session",
		definition: "The number of tool calls the agent made in a session.",
		measurement: "counted",
		unit: "calls per session",
		denominator: "sessions",
		limitations: [
			"Harnesses split work into calls differently, and Claude Code names its tools differently from Pi.",
			"A call a sub-agent made counts in the child session and not in the parent.",
		],
	},
	{
		id: `${CORE_OWNER}.sessions-with-sub-agents`,
		name: "Sessions with sub-agents",
		definition: "The number of top-level sessions that started at least one child session.",
		measurement: "counted",
		unit: "sessions",
		denominator: "none",
		limitations: ["A child session whose transcript sync never read is missing, so a parent that started only such children is not counted."],
	},
	{
		id: `${CORE_OWNER}.sub-agent-sessions`,
		name: "Sub-agent sessions",
		definition: "The number of child sessions that top-level sessions started.",
		measurement: "counted",
		unit: "sessions",
		denominator: "none",
		limitations: ["A child session whose transcript sync never read is missing from the count.", "Pair it with the sessions-with-sub-agents figure: one parent can start many children."],
	},
	{
		id: `${CORE_OWNER}.raw-tool-error-rate`,
		name: "Raw tool error rate",
		definition: "The share of tool results that the host flagged as an error.",
		measurement: "counted",
		unit: "percent of tool results",
		denominator: "tool results",
		limitations: [
			"Each harness chooses what to flag. One flags a non-zero exit from grep as an error, and another treats it as an ordinary answer.",
			"A shift toward the shell moves the rate, because shell commands fail more often than reads.",
			"The rate does not depend on pairing calls with results, so it stays comparable for sessions that failure-modes could not pair.",
			LIMIT_HARNESS,
		],
	},
	{
		id: `${CORE_OWNER}.model-recorded`,
		name: "Model recorded",
		definition: "The model name stored with an assistant message, and the share of steps per model family.",
		measurement: "counted",
		unit: "percent of assistant steps",
		denominator: "assistant steps with a recorded model",
		limitations: [
			"Sessions indexed before sync stored the model have none, and the figure reads as unknown and never as zero.",
			"A routed alias, such as a tier name, hides the model that answered.",
			"A share by family covers recorded steps only.",
		],
	},
	{
		id: `${CORE_OWNER}.billed-cost`,
		name: "Billed cost",
		definition: "The dollar amount that the host recorded for one assistant message. A message without a recorded cost, or with a cost of zero, is null.",
		measurement: "counted",
		unit: "dollars per message, turn bucket or session",
		denominator: "priced messages",
		limitations: [
			"Only Pi, OpenCode and Cline record it, and only for sessions indexed after sync stored it.",
			"A total that omits unpriced messages says so. Dollar figures don't compare across harnesses or months.",
			LIMIT_PARALLEL,
		],
	},
];
