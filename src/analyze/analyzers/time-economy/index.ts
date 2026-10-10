/**
 * time-economy — where a session's wall-clock time went (issue #306).
 *
 * Every other analyzer counts turns, tokens, or friction; none reads the clock.
 * Yet "the session was slow" is one of the most common complaints about a
 * coding agent, and the transcript already records when each tool call was
 * issued and when its result arrived. This analyzer turns those timestamps into
 * one session-anchored node: time per command family, active versus idle time,
 * waits that block inside a single call, and wait loops that cannot end
 * because their `pgrep -f` / `ps | grep` pattern matches the loop itself.
 *
 * Deterministic, no LLM. Timing rules are documented in `detect.ts`. A call
 * that cannot be timed is counted as untimed, never as zero seconds.
 *
 * Background work is out of scope for this version: a call the harness runs in
 * the background returns at once, and the record of its completion is not yet
 * ingested, so such a call times as near-instant.
 */

import type {
	Analyzer,
	AnalyzerDef,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	AnalysisResult,
	AnalysisUnit,
	MessageRow,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeConfigHash, shortHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { Type, type Static } from "typebox";
import { DEFAULT_TIME_ECONOMY_CONFIG, type TimeEconomyConfig } from "./config.js";
import {
	FamilyTimeSchema,
	InCallWaitsSchema,
	SelfMatchingWaitSchema,
	measureTime,
	type TimeScan,
} from "./detect.js";

/** A proposal this analyzer embeds in its node; materialised by the framework. */
export const TimeEconomyRawProposal = Type.Object({
	target_type: Type.String(),
	title: Type.String(),
	summary: Type.String(),
	detail: Type.String(),
	evidence: Type.String(),
	confidence: Type.Number(),
	severity: Type.String(),
});
export type TimeEconomyRawProposal = Static<typeof TimeEconomyRawProposal>;

/** The properties a time-economy node carries in its `contentJson`. */
export const TIME_ECONOMY_PROPERTIES = Type.Object({
	session_id: Type.String(),
	timed_call_count: Type.Number(),
	/** Calls with no result, or with a missing or out-of-order timestamp. */
	untimed_call_count: Type.Number(),
	tool_seconds: Type.Number(),
	wall_clock_seconds: Type.Number(),
	/** Tool-call spans plus message gaps up to the idle cap, overlaps counted once. */
	active_seconds: Type.Number(),
	families: Type.Array(FamilyTimeSchema),
	in_call_waits: InCallWaitsSchema,
	self_matching_waits: Type.Array(SelfMatchingWaitSchema),
	improvement_proposals: Type.Array(TimeEconomyRawProposal),
});
export type TimeEconomyProperties = Static<typeof TIME_ECONOMY_PROPERTIES>;

export const TIME_ECONOMY_DEF: AnalyzerDef = {
	id: "time-economy",
	label: "Time Economy (deterministic)",
	description:
		"Measures where a session's wall-clock time went from the host's own timestamps: seconds per command family, active versus idle time, waits that block inside one tool call, and pgrep -f / ps | grep wait loops that match their own command line and cannot end. Deterministic, no LLM. Proposes a change when in-call waiting or a self-matching loop passes its threshold.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: TIME_ECONOMY_PROPERTIES,
};

export const TIME_ECONOMY_VERSION: AnalyzerVersion = {
	analyzerId: TIME_ECONOMY_DEF.id,
	// 1.0 (issue #306): synchronous tool-call timing, command families, in-call
	// waits, and self-matching wait loops.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/time-economy/index.ts",
};

function resolveConfig(raw: unknown): TimeEconomyConfig {
	return (raw as TimeEconomyConfig) ?? DEFAULT_TIME_ECONOMY_CONFIG;
}

/**
 * Fingerprint of everything the timing reads: each message's id, role,
 * timestamp, tool calls, and tool results. A re-sync that backfills a
 * timestamp or a result re-identifies the unit as missing.
 */
function timeFingerprint(messages: readonly MessageRow[]): string {
	const lines: string[] = [];
	for (const m of messages) {
		lines.push(
			[m.id, m.role, m.timestamp ?? "", m.tool_calls ? shortHash(m.tool_calls) : "", m.tool_results ? shortHash(m.tool_results) : ""].join(":"),
		);
	}
	return shortHash(lines.join("\n"));
}

const minutes = (seconds: number): number => Math.round(seconds / 60);
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** The proposals a scan earns under the configured thresholds. */
export function buildProposals(scan: TimeScan, config: TimeEconomyConfig): TimeEconomyRawProposal[] {
	const proposals: TimeEconomyRawProposal[] = [];
	const waits = scan.in_call_waits;

	if (waits.seconds >= config.waitProposalMinSeconds && waits.call_count > 0) {
		const share = scan.active_seconds > 0 ? Math.round((100 * waits.seconds) / scan.active_seconds) : 0;
		proposals.push({
			target_type: "agents_md",
			title: `${waits.call_count} tool ${plural(waits.call_count, "call", "calls")} waited ${minutes(waits.seconds)} min inside the call`,
			summary:
				`Waiting inside tool calls took ${share}% of the session's ${minutes(scan.active_seconds)} active minutes. ` +
				"Each call blocked the agent in a sleep loop, a long sleep, or a blocking watcher until it returned.",
			detail:
				"Start long-running work in the background and act on the harness's completion notice, or check its state once per turn with a bounded command. " +
				"When a wait is unavoidable, wait on the exact process (`wait $pid`, `kill -0 $pid`) or on a file the work writes when it exits, and give the wait a timeout that reports which condition ended it.",
			evidence: `Longest wait ${minutes(waits.longest_seconds)} min; issuing messages, longest first: ${waits.message_ids.join(", ")}`,
			confidence: 0.8,
			severity: "waste",
		});
	}

	const stuck = scan.self_matching_waits.filter((w) => w.seconds >= config.selfMatchProposalMinSeconds);
	if (stuck.length > 0) {
		const total = stuck.reduce((s, w) => s + w.seconds, 0);
		proposals.push({
			target_type: "agents_md",
			title: `${stuck.length} wait ${plural(stuck.length, "loop matched its own command line", "loops matched their own command lines")}`,
			summary:
				`A \`pgrep -f\` or \`ps | grep\` pattern also matched the shell running the loop, so the loop could not see the process it waited on exit. ` +
				`${plural(stuck.length, "It", "They")} kept waiting for ${minutes(total)} min in total.`,
			detail:
				"`pgrep -f` matches against full command lines, and the shell running the loop has the pattern in its own command line. " +
				"Wait on the process id instead (`wait $pid`, or `while kill -0 $pid`), poll a file the work writes when it exits, or bracket the pattern (`pgrep -f '[s]moke.sh'`) so it cannot match the loop.",
			evidence: stuck.map((w) => `${w.message_id} (${minutes(w.seconds)} min)`).join(", "),
			confidence: 0.9,
			severity: "waste",
		});
	}

	return proposals;
}

export const timeEconomyAnalyzer: Analyzer = {
	def: TIME_ECONOMY_DEF,
	version: TIME_ECONOMY_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: TIME_ECONOMY_DEF.id,
		configHash: computeConfigHash(DEFAULT_TIME_ECONOMY_CONFIG),
		configJson: DEFAULT_TIME_ECONOMY_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		if (ctx.messages.length === 0) return [];
		const fingerprint = timeFingerprint(ctx.messages);
		const sources: SourceRef[] = [{ kind: "session", id: `${ctx.sessionId}#time=${fingerprint}` }];
		return [
			{
				sources,
				sourceSetHash: shortHash(`time-economy(${ctx.sessionId}|${fingerprint})`),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
			},
		];
	},

	async analyze(_unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		const scan = measureTime(messages, config);
		const proposals = buildProposals(scan, config);
		const properties: TimeEconomyProperties = { session_id: ctx.sessionId, ...scan, improvement_proposals: proposals };

		// Anchor the session and every call a finding names, so each proposal
		// walks back to the exact calls that waited.
		const anchored = [...new Set([...scan.in_call_waits.message_ids, ...scan.self_matching_waits.map((w) => w.message_id)])];
		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
			...anchored.map((id, i) => ({ toRefKind: REF_KINDS.MESSAGE, toRefId: id, edgeKind: EDGE_KINDS.ANCHORS, ordinal: i + 1 })),
		];

		return {
			nodeKind: proposals.length > 0 ? "proposal" : "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			edges,
		};
	},
};
