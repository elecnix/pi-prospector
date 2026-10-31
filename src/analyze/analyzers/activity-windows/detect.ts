/**
 * Activity windows: when a session was running.
 *
 * A window is a stretch of wall-clock time the session was active. It is built
 * from the host's own timestamps: each gap between two messages counts up to the
 * idle cap, and each timed tool call counts for its whole span, because a call
 * that runs for ten minutes was running even though nobody wrote anything. The
 * stretches are unioned and adjacent ones merged, so the windows never overlap.
 *
 * A message with no timestamp contributes nothing and is counted, never assumed
 * to be instant.
 */

import type { MessageRow } from "../../types.js";
import { buildToolStream } from "../../tool-stream.js";
import { DEFAULT_ACTIVITY_WINDOWS_CONFIG, type ActivityWindowsConfig } from "./config.js";

/** One stretch of activity, as epoch milliseconds, end exclusive. */
export type Interval = readonly [number, number];

export interface ActivityScan {
	/** Merged, ordered, non-overlapping windows as ISO instants. */
	windows: Array<{ start: string; end: string }>;
	/** Messages that carried no usable timestamp. */
	untimed_message_count: number;
	active_seconds: number;
}

/** Merge intervals into an ordered, non-overlapping list. Touching intervals join. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
	const sorted = [...intervals].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
	const merged: Array<[number, number]> = [];
	for (const [start, end] of sorted) {
		const last = merged[merged.length - 1];
		if (last && start <= last[1]) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	return merged;
}

function timeOf(m: MessageRow): number | null {
	if (m.timestamp === null) return null;
	const t = Date.parse(m.timestamp);
	return Number.isFinite(t) ? t : null;
}

/** The windows a session was active in. */
export function scanActivity(
	messages: MessageRow[],
	config: ActivityWindowsConfig = DEFAULT_ACTIVITY_WINDOWS_CONFIG,
): ActivityScan {
	const timeById = new Map<string, number>();
	let untimed = 0;
	for (const m of messages) {
		const t = timeOf(m);
		if (t === null) untimed++;
		else timeById.set(m.id, t);
	}

	const intervals: Interval[] = [];
	const capMs = config.idleCapSeconds * 1000;
	const times = [...timeById.values()].sort((a, b) => a - b);
	for (let i = 0; i + 1 < times.length; i++) {
		const a = times[i]!;
		intervals.push([a, a + Math.min(times[i + 1]! - a, capMs)]);
	}
	for (const call of buildToolStream(messages).invocations) {
		const start = timeById.get(call.messageId);
		const end = call.outcome ? timeById.get(call.outcome.messageId) : undefined;
		if (start !== undefined && end !== undefined && end > start) intervals.push([start, end]);
	}

	const merged = mergeIntervals(intervals);
	return {
		windows: merged.map(([s, e]) => ({ start: new Date(s).toISOString(), end: new Date(e).toISOString() })),
		untimed_message_count: untimed,
		active_seconds: Math.round(merged.reduce((n, [s, e]) => n + (e - s), 0) / 1000),
	};
}
