/**
 * activity-windows — when each session was running.
 *
 * A session's start and end say little about how much of the time between them
 * anything ran. This analyzer writes the stretches the session was active, from
 * the host's own timestamps (gaps up to an idle cap, and the whole span of every
 * timed tool call). One session-anchored metric node per session, with the
 * windows, their total, and the count of messages that carried no timestamp.
 * Deterministic, no LLM, and it proposes nothing.
 *
 * How many sessions ran at once is a corpus question, so it is not in any node:
 * the `concurrency` output folds every session's windows at read time (see
 * `concurrency.ts`). That separates the operator's working hours from agent-hours.
 */

import type {
	Analyzer,
	AnalyzerDef,
	AnalyzerOutput,
	AnalyzerOutputContext,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	AnalysisResult,
	AnalysisUnit,
	MessageRow,
	OutputArtifact,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeConfigHash, shortHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { latestBySession } from "../../outputs.js";
import { Type, type Static } from "typebox";
import { DEFAULT_ACTIVITY_WINDOWS_CONFIG, type ActivityWindowsConfig } from "./config.js";
import { scanActivity } from "./detect.js";
import { foldConcurrency, type Bucket } from "./concurrency.js";

/** The properties an activity-windows node carries in its `contentJson`. */
export const ACTIVITY_WINDOWS_PROPERTIES = Type.Object({
	session_id: Type.String(),
	windows: Type.Array(Type.Object({ start: Type.String(), end: Type.String() })),
	active_seconds: Type.Number(),
	untimed_message_count: Type.Number(),
});
export type ActivityWindowsProperties = Static<typeof ACTIVITY_WINDOWS_PROPERTIES>;

export const ACTIVITY_WINDOWS_DEF: AnalyzerDef = {
	id: "activity-windows",
	label: "Activity Windows (deterministic)",
	description:
		"Records the stretches a session was active, from the host's timestamps: each gap between messages up to an idle cap, and the whole span of every timed tool call, merged into non-overlapping windows. Also counts messages with no timestamp. One session-anchored metric node per session. The `concurrency` output folds every session's windows into sessions, peak overlap, and agent minutes per hour or day. Deterministic, no LLM; it proposes nothing.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: ACTIVITY_WINDOWS_PROPERTIES,
};

export const ACTIVITY_WINDOWS_VERSION: AnalyzerVersion = {
	analyzerId: ACTIVITY_WINDOWS_DEF.id,
	// 1.0: activity windows from message gaps and timed tool-call spans.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/activity-windows/index.ts",
};

function resolveConfig(raw: unknown): ActivityWindowsConfig {
	return { ...DEFAULT_ACTIVITY_WINDOWS_CONFIG, ...((raw as Partial<ActivityWindowsConfig> | null | undefined) ?? {}) };
}

/** Fingerprint of what the scan reads: ids, roles, timestamps, and the call and result ids. */
function windowsFingerprint(messages: readonly MessageRow[]): string {
	return shortHash(
		messages
			.map((m) =>
				[
					m.id,
					m.role,
					m.timestamp ?? "",
					m.tool_calls ? shortHash(m.tool_calls) : "",
					m.tool_results ? shortHash(m.tool_results) : "",
				].join(":"),
			)
			.join("\n"),
	);
}

const concurrencyOutput: AnalyzerOutput = {
	def: {
		id: "concurrency",
		label: "Concurrent sessions (CSV)",
		description:
			"One row per hour (or day) with activity: distinct sessions active, the most active at the same moment, and summed active minutes. Times are UTC. Options: `bucket` (`hour` or `day`, default `hour`), `day` (`YYYY-MM-DD` in UTC, default all days). Active minutes are agent time, not the operator's.",
	},
	render: async (ctx: AnalyzerOutputContext): Promise<OutputArtifact[]> => {
		const bucket = (ctx.options.bucket ?? "hour").trim() as Bucket;
		if (bucket !== "hour" && bucket !== "day") throw new Error(`bucket must be 'hour' or 'day', got '${ctx.options.bucket}'`);
		const day = (ctx.options.day ?? "all").trim();
		if (day !== "all" && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`day must be YYYY-MM-DD or 'all', got '${day}'`);

		const sessions = latestBySession(await ctx.ownNodes).map((node) => {
			const content = JSON.parse(node.content_json) as ActivityWindowsProperties;
			return {
				sessionId: node.session_id,
				windows: content.windows.map((w) => [Date.parse(w.start), Date.parse(w.end)] as const),
			};
		});
		const rows = foldConcurrency(sessions, bucket).filter((r) => day === "all" || r.bucket_start.startsWith(day));
		const header = "bucket_start,sessions,peak_concurrent,active_minutes";
		return [
			{
				filename: `concurrency-${bucket}-${day}.csv`,
				mediaType: "text/csv",
				content: [header, ...rows.map((r) => [r.bucket_start, r.sessions, r.peak_concurrent, r.active_minutes].join(","))].join("\n") + "\n",
				summary: `${rows.length} ${bucket}(s) with activity, peak ${Math.max(0, ...rows.map((r) => r.peak_concurrent))} at once`,
			},
		];
	},
};

export const activityWindowsAnalyzer: Analyzer = {
	def: ACTIVITY_WINDOWS_DEF,
	version: ACTIVITY_WINDOWS_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: ACTIVITY_WINDOWS_DEF.id,
		configHash: computeConfigHash(DEFAULT_ACTIVITY_WINDOWS_CONFIG),
		configJson: DEFAULT_ACTIVITY_WINDOWS_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},
	outputs: [concurrencyOutput],

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		if (ctx.messages.length === 0) return [];
		const sources: SourceRef[] = [{ kind: "session", id: ctx.sessionId }];
		return [
			{
				sources,
				sourceSetHash: shortHash(`activity-windows(${ctx.sessionId}|${windowsFingerprint(ctx.messages)})`),
				anchorKind: "session" as const,
				anchorRef: ctx.sessionId,
			},
		];
	},

	async analyze(_unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const scan = scanActivity(await ctx.getSessionMessages(ctx.sessionId), config);
		const properties: ActivityWindowsProperties = { session_id: ctx.sessionId, ...scan };
		return {
			nodeKind: "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			edges: [{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 }],
		};
	},
};
