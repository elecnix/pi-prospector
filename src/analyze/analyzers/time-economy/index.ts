/**
 * time-economy — where a session's wall-clock time went (issue #306).
 *
 * Every other analyzer counts turns, tokens, or friction; none reads the clock.
 * Yet "the session was slow" is one of the most common complaints about a
 * coding agent, and the transcript already records when each tool call was
 * issued and when its result arrived. This analyzer turns those timestamps into
 * one session-anchored node: time per command family, active versus idle time,
 * waits that block inside a single call, calls that ran until the harness
 * timed them out, wait loops that cannot end because their `pgrep -f` /
 * `ps | grep` pattern matches the loop itself, the background calls the
 * harness ran away from, the failures a pipe hid from the exit code, the
 * spans between commits, and the spans a skill occupied.
 *
 * Deterministic, no LLM. Timing rules are documented in `detect.ts`, the
 * span rules in `phases.ts`. A call that cannot be timed is counted as
 * untimed, never as zero seconds.
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
	TimedOutCallsSchema,
	BackgroundCallsSchema,
	measureTime,
	type TimeScan,
} from "./detect.js";
import { PhaseSpanSchema, SkillSpanSchema, HiddenExitCodeSchema, type PhaseSpan, type SkillSpan } from "./spans.js";
import { measurePhaseSpans, measureSkillSpans, type SpanRow } from "./phases.js";
import { isPreparationCommand, isCommitCommand, commitSubjectOf } from "./spans.js";
import type { AsyncDatabase } from "../../../db/async-db.js";
import { getBackgroundTasksForSession } from "../../../db/queries.js";
import type { BackgroundTaskRow } from "../../types.js";

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
	timed_out_calls: TimedOutCallsSchema,
	/** Backgrounded calls, timed by the host's real completion record. */
	background_calls: BackgroundCallsSchema,
	/** Successful calls whose output says the work failed anyway. */
	hidden_exit_codes: Type.Array(HiddenExitCodeSchema),
	/** The spans between the session's start and its commits. */
	phase_spans: Type.Array(PhaseSpanSchema),
	/** The spans each skill occupied the agent. */
	skill_spans: Type.Array(SkillSpanSchema),
	improvement_proposals: Type.Array(TimeEconomyRawProposal),
});
export type TimeEconomyProperties = Static<typeof TIME_ECONOMY_PROPERTIES>;

export const TIME_ECONOMY_DEF: AnalyzerDef = {
	id: "time-economy",
	label: "Time Economy (deterministic)",
	description:
		"Measures where a session's wall-clock time went from the host's own timestamps: seconds per command family, active versus idle time, waits that block inside one tool call, calls that ran until the harness timed them out, pgrep -f / ps | grep wait loops that match their own command line, background calls timed by their real completion, failures a pipe hid from the exit code, the spans between commits, and the spans a skill occupied. Deterministic, no LLM. Proposes a change when in-call waiting, harness timeouts, a self-matching loop, a hidden exit code, or a slow phase span passes its threshold.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: TIME_ECONOMY_PROPERTIES,
};

export const TIME_ECONOMY_VERSION: AnalyzerVersion = {
	analyzerId: TIME_ECONOMY_DEF.id,
	// 1.0 (issue #306): synchronous tool-call timing, command families, in-call
	// waits, harness timeouts, and self-matching wait loops.
	//
	// 2.0 (issue #306): background calls are now timed by the host's own
	// completion record rather than by the acknowledgement the transcript
	// recorded for them; successful calls whose output says the work failed
	// are detected (the exit code a pipe hid); the spans from the session's
	// start to its first commit and of each commit's preparation are measured;
	// and the spans a skill occupied are measured. Major: previously reported
	// durations change — a background call that used to time as near-instant
	// now times as the work it actually was — and findings that did not exist
	// now appear.
	major: 2,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/time-economy/index.ts",
};

/** The stored config over the defaults, so a partial config cannot leave a threshold undefined. */
export function resolveConfig(raw: unknown): TimeEconomyConfig {
	return { ...DEFAULT_TIME_ECONOMY_CONFIG, ...((raw as Partial<TimeEconomyConfig> | null | undefined) ?? {}) };
}

/**
 * Fingerprint of everything the timing reads: each message's id, role,
 * timestamp, tool calls, and tool results, plus the background-task
 * completions and the per-message usage the spans report.
 *
 * A re-sync that backfills a timestamp, a result, a usage figure, or a
 * background task's completion re-identifies the unit as missing, so the
 * node is recomputed rather than reused with stale inputs. Leaving the
 * background tasks out of the fingerprint would be the worse mistake: the
 * node's content would change while its recipe identity stayed the same,
 * and the append-only graph would hold two different conclusions under one
 * identity.
 */
function timeFingerprint(messages: readonly MessageRow[], backgroundTasks: readonly BackgroundTaskRow[], usageById: ReadonlyMap<string, string | null>): string {
	const lines: string[] = [];
	for (const m of messages) {
		lines.push(
			[
				m.id,
				m.role,
				m.timestamp ?? "",
				m.tool_calls ? shortHash(m.tool_calls) : "",
				m.tool_results ? shortHash(m.tool_results) : "",
				usageById.get(m.id) ?? "",
			].join(":"),
		);
	}
	// The background completions, in a stable order.
	const tasks = [...backgroundTasks]
		.map((t) => `${t.tool_use_id}:${t.completed_at}:${t.status ?? ""}`)
		.sort();
	return shortHash([...lines, ...tasks].join("\n"));
}

const minutes = (seconds: number): number => Math.round(seconds / 60);
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * The session's message rows with the `usage` column attached, and the usage
 * figures by message id.
 *
 * MessageRow does not carry `usage` — the token buckets live in their own
 * column — and the spans report tokens, so the rows are read once with it.
 * The map comes back too because the fingerprint has to cover the usage the
 * node's content depends on.
 */
async function loadSpanRows(
	db: AsyncDatabase,
	sessionId: string,
	messages: readonly MessageRow[],
): Promise<{ rows: SpanRow[]; usageById: Map<string, string | null> }> {
	const usageById = new Map<string, string | null>();
	try {
		const rows = (await db
			.prepare("SELECT id, usage FROM messages WHERE session_id = ?")
			.all(sessionId)) as Array<{ id: string; usage: string | null }>;
		for (const row of rows) usageById.set(row.id, row.usage);
	} catch {
		// A session whose usage column cannot be read has no token figures; the
		// spans then report tokens as unknown, which is the honest answer.
	}
	return { rows: messages.map((m) => ({ ...m, usage: usageById.get(m.id) ?? null })), usageById };
}

/** The proposals a scan earns under the configured thresholds. */
export function buildProposals(
	scan: TimeScan,
	config: TimeEconomyConfig,
	phaseSpans: readonly PhaseSpan[] = [],
	skillSpans: readonly SkillSpan[] = [],
): TimeEconomyRawProposal[] {
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

	const timeouts = scan.timed_out_calls;
	if (timeouts.call_count >= config.timeoutProposalMinCalls) {
		proposals.push({
			target_type: "agents_md",
			title: `${timeouts.call_count} tool calls ran until the harness timed them out`,
			summary:
				`The agent waited out the harness's tool timeout ${timeouts.call_count} times, ${minutes(timeouts.seconds)} min in total, ` +
				"before it learned that each command was still running.",
			detail:
				"Run a command that can outlast the tool timeout (a full test or gate run, a build, a container start) in the background from the start, and act on its completion notice. " +
				"When it has to run in the foreground, set the call's timeout above the command's expected duration.",
			evidence: `Issuing messages, in session order: ${timeouts.message_ids.join(", ")}`,
			confidence: 0.85,
			severity: "waste",
		});
	}

	// Only a loop that ran until something outside it stopped it is evidence:
	// a loop that broke out early saw its target exit, whatever its syntax.
	const stuck = scan.self_matching_waits.filter((w) => w.ran_to_limit && w.seconds >= config.selfMatchProposalMinSeconds);
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

	// A failure the exit code hid: the pipe returned its own status, so the
	// harness called the call successful while the output said otherwise.
	const hidden = scan.hidden_exit_codes;
	if (hidden.length >= config.hiddenExitProposalMinCalls) {
		const families = [...new Set(hidden.map((h) => h.family))];
		proposals.push({
			target_type: "agents_md",
			title: `${hidden.length} tool ${plural(hidden.length, "call", "calls")} reported success while the output showed a failure`,
			summary:
				`${hidden.length} ${plural(hidden.length, "call", "calls")} returned a zero exit code while the output carried a failure marker, so the agent read a failing command as a passing one. ` +
				`The families involved: ${families.join(", ")}.`,
			detail:
				"A command behind a pipe reports the pipe's status, not its own: `cmd 2>&1 | tail -40` exits 0 when `cmd` fails. " +
				"Check the command's own status before piping it (`set -o pipefail`, or `cmd; test ${PIPESTATUS[0]} -eq 0`), and when the output is what matters, keep the exit status separate from the text.",
			evidence: hidden.map((h) => `${h.message_id} (${h.family}: ${h.markers.join(", ")})`).join("; "),
			confidence: 0.8,
			severity: "friction",
		});
	}

	// A commit that took a long time to prepare is a phase the operator feels.
	const slowPreparations = phaseSpans.filter(
		(s) => s.kind === "commit_preparation" && s.seconds >= config.phaseSpanProposalMinSeconds,
	);
	if (slowPreparations.length > 0) {
		const slowest = [...slowPreparations].sort((a, b) => b.seconds - a.seconds);
		proposals.push({
			target_type: "agents_md",
			title: `${slowPreparations.length} ${plural(slowPreparations.length, "commit took", "commits took")} a long time to prepare`,
			summary:
				`The slowest commit's preparation took ${minutes(slowest[0]!.seconds)} min across ${slowest[0]!.turns} turns` +
				(slowest[0]!.tokens !== null ? ` and ${slowest[0]!.tokens} tokens` : "") +
				", measured from the first test run, `git add`, review, or PR skill after the previous commit to the commit itself.",
			detail:
				"Run the verification the commit depends on once, not once per edit, and stage the work when it is ready rather than rebuilding it from the last test run. " +
				"When a commit needs a review, start it as soon as the change is complete, so the wait overlaps the work that follows.",
			evidence: slowest
				.map((s) => `${s.commit_subject ?? s.end_message_id ?? "commit"} (${minutes(s.seconds)} min, ${s.turns} turns)`)
				.join(", "),
			confidence: 0.75,
			severity: "waste",
		});
	}

	// A skill that occupied the agent for a long time is worth a look: either
	// the skill is doing too much, or it was invoked where it did not belong.
	const slowSkills = skillSpans.filter((s) => s.seconds >= config.skillSpanProposalMinSeconds);
	if (slowSkills.length > 0) {
		const slowest = [...slowSkills].sort((a, b) => b.seconds - a.seconds);
		const names = [...new Set(slowest.map((s) => s.skill))];
		proposals.push({
			target_type: "agents_md",
			title: `${slowSkills.length} skill ${plural(slowSkills.length, "span took", "spans took")} a long time`,
			summary:
				`The slowest skill span took ${minutes(slowest[0]!.seconds)} min across ${slowest[0]!.turns} turns` +
				(slowest[0]!.tokens !== null ? ` and ${slowest[0]!.tokens} tokens` : "") +
				`. The skills involved: ${names.join(", ")}.`,
			detail:
				"A skill span runs from its `Skill` call to the next one, to the end of the turn, or — for a pull-request skill — to its successful `gh pr create`. " +
				"When a skill reliably runs long, split the work it bundles, or narrow the step that calls it, so the agent can report progress between the parts.",
			evidence: slowest.map((s) => `${s.skill} (${minutes(s.seconds)} min, ${s.turns} turns, ${s.end_reason})`).join(", "),
			confidence: 0.7,
			severity: "suggestion",
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

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		if (ctx.messages.length === 0) return [];

		// The spans need the `usage` column, which MessageRow does not carry, so
		// they are computed here — the only place with a database handle — and
		// handed to analyze() through the unit's meta. That is the same
		// division context-economy uses for the same reason.
		const { rows, usageById } = await loadSpanRows(ctx.db, ctx.sessionId, ctx.messages);
		const backgroundTasks = await getBackgroundTasksForSession(ctx.db, ctx.sessionId);
		const phaseSpans = measurePhaseSpans(rows, {
			isCommit: isCommitCommand,
			isPreparation: isPreparationCommand,
			commitSubject: commitSubjectOf,
		});
		const skillSpans = measureSkillSpans(rows);

		// The fingerprint covers every input the node's content depends on,
		// including the background completions and the usage figures.
		const fingerprint = timeFingerprint(ctx.messages, backgroundTasks, usageById);
		const sources: SourceRef[] = [{ kind: "session", id: `${ctx.sessionId}#time=${fingerprint}` }];
		return [
			{
				sources,
				sourceSetHash: shortHash(`time-economy(${ctx.sessionId}|${fingerprint})`),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
				meta: { phaseSpans, skillSpans, backgroundTasks },
			},
		];
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		// The same snapshot the fingerprint was computed over, so the node's
		// content and its recipe identity always describe the same inputs.
		const backgroundTasks = (unit.meta?.["backgroundTasks"] as BackgroundTaskRow[] | undefined) ?? (await ctx.getBackgroundTasks(ctx.sessionId));
		const scan = measureTime(messages, config, backgroundTasks);

		const phaseSpans = (unit.meta?.["phaseSpans"] as PhaseSpan[] | undefined) ?? [];
		const skillSpans = (unit.meta?.["skillSpans"] as SkillSpan[] | undefined) ?? [];

		const proposals = buildProposals(scan, config, phaseSpans, skillSpans);
		const properties: TimeEconomyProperties = {
			session_id: ctx.sessionId,
			...scan,
			phase_spans: phaseSpans,
			skill_spans: skillSpans,
			improvement_proposals: proposals,
		};

		// Anchor the session and every call a finding names, so each proposal
		// walks back to the exact calls that waited.
		const anchored = [
			...new Set([
				...scan.in_call_waits.message_ids,
				...scan.self_matching_waits.map((w) => w.message_id),
				...scan.hidden_exit_codes.map((h) => h.message_id),
				...scan.background_calls.calls.map((b) => b.message_id),
				...skillSpans.map((s) => s.message_id),
			]),
		];
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
