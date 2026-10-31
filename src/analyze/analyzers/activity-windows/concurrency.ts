/**
 * The concurrency fold: how many sessions ran at once.
 *
 * Concurrency belongs to the corpus, not to a session. Stored in a session's
 * node it would change whenever any other session was added, so each node keeps
 * only its own windows and this read-time fold counts the overlap. The fold is a
 * pure function of the windows, so it is always current and caches nothing.
 */

import type { Interval } from "./detect.js";

export type Bucket = "hour" | "day";

export interface ConcurrencyRow {
	/** Start of the bucket, UTC, as an ISO instant. */
	bucket_start: string;
	/** Distinct sessions with any activity in the bucket. */
	sessions: number;
	/** The most sessions active at the same moment within the bucket. */
	peak_concurrent: number;
	/** Summed minutes of activity across sessions: agent time, not the operator's. */
	active_minutes: number;
}

const BUCKET_MS: Record<Bucket, number> = { hour: 3_600_000, day: 86_400_000 };

/** Fold per-session windows into one row per bucket that saw activity, oldest first. */
export function foldConcurrency(
	sessions: ReadonlyArray<{ sessionId: string; windows: readonly Interval[] }>,
	bucket: Bucket = "hour",
): ConcurrencyRow[] {
	const size = BUCKET_MS[bucket];
	const buckets = new Map<number, Array<{ sessionId: string; start: number; end: number }>>();
	for (const { sessionId, windows } of sessions) {
		for (const [start, end] of windows) {
			for (let b = Math.floor(start / size) * size; b < end; b += size) {
				const list = buckets.get(b) ?? [];
				list.push({ sessionId, start: Math.max(start, b), end: Math.min(end, b + size) });
				buckets.set(b, list);
			}
		}
	}

	return [...buckets.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([b, parts]) => {
			// Sweep the starts and ends. Ends sort before starts at the same instant, so
			// two sessions that touch are not counted as overlapping.
			const events = parts.flatMap((p) => [
				[p.start, 1],
				[p.end, -1],
			] as const);
			events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
			let open = 0;
			let peak = 0;
			for (const [, delta] of events) {
				open += delta;
				if (open > peak) peak = open;
			}
			return {
				bucket_start: new Date(b).toISOString(),
				sessions: new Set(parts.map((p) => p.sessionId)).size,
				peak_concurrent: peak,
				active_minutes: Math.round((parts.reduce((n, p) => n + (p.end - p.start), 0) / 60_000) * 10) / 10,
			};
		});
}
