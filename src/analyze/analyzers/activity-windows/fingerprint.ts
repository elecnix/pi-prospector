import type { FingerprintContributor } from "../../../fingerprint/contributor.js";
import { mergeIntervals, type Interval } from "./detect.js";

/** The fixed buckets of a session's peak concurrency. */
export const CONCURRENCY_BUCKETS = ["1", "2", "3-4", "5-9", "10-19", "20-49", "50-or-more"] as const;

/**
 * For each session, the most sessions active at the same moment while it was
 * active, itself included. Ends sort before starts at the same instant, so two
 * sessions that only touch do not overlap, as in the concurrency output.
 */
export function peakConcurrency(sessions: ReadonlyArray<{ id: string; windows: readonly Interval[] }>): Map<string, number> {
	const events: Array<[number, -1 | 1, string]> = [];
	for (const { id, windows } of sessions) for (const [start, end] of windows) if (end > start) events.push([start, 1, id], [end, -1, id]);
	events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
	const open = new Map<string, number>();
	const peak = new Map<string, number>();
	for (const [, delta, id] of events) {
		if (delta === -1) {
			const left = (open.get(id) ?? 0) - 1;
			if (left === 0) open.delete(id);
			else open.set(id, left);
			continue;
		}
		open.set(id, (open.get(id) ?? 0) + 1);
		for (const active of open.keys()) peak.set(active, Math.max(peak.get(active) ?? 0, open.size));
	}
	return peak;
}

/** The bucket of a peak. The wide upper buckets fit a person whose orchestrators start dozens of sessions at once. */
export function concurrencyBucket(peak: number): (typeof CONCURRENCY_BUCKETS)[number] {
	if (peak <= 1) return "1";
	if (peak === 2) return "2";
	if (peak <= 4) return "3-4";
	if (peak <= 9) return "5-9";
	if (peak <= 19) return "10-19";
	return peak <= 49 ? "20-49" : "50-or-more";
}

/**
 * How parallel a person works, from each session's activity windows. Counted
 * from the host's timestamps, so the figures are objective. Concurrency is read
 * across the sessions in the fingerprint's scope, at read time, as the
 * `concurrency` output reads it. The parts of the day stay out of the shared
 * fingerprint: they sketch the person's daily schedule, and the researcher who
 * shares a fingerprint chose not to publish them (2026-11-25).
 */
export const activityWindowsFingerprint: FingerprintContributor = {
	def: {
		id: "activityWindows",
		label: "Activity windows",
		description:
			"Sessions by the most sessions active at the same moment while they were, which shows how many agents a person runs in parallel. From timestamps, not from language. Published without the parts of the day, which would sketch a daily schedule.",
		kind: "objective",
		analyzers: ["activity-windows"],
		measures: [
			{ kind: "groups", id: "byPeakConcurrency", metric: "activity-windows.concurrency", dimensions: { concurrent: [...CONCURRENCY_BUCKETS] } },
		],
	},
	async read(ctx) {
		const measured = await ctx.runs("activity-windows");
		const items = await ctx.items("activity-windows", "$.windows", { start: "$.start", end: "$.end" });
		const raw = new Map<string, Interval[]>();
		for (const w of items) {
			const start = Date.parse(String(w["start"]));
			const end = Date.parse(String(w["end"]));
			if (Number.isNaN(start) || Number.isNaN(end)) throw new Error(`activity-windows: a window of a session does not hold two timestamps`);
			const list = raw.get(String(w["session"])) ?? [];
			list.push([start, end]);
			raw.set(String(w["session"]), list);
		}
		const sessions = [...raw].map(([id, windows]) => ({ id, windows: mergeIntervals(windows) }));
		const peaks = peakConcurrency(sessions);
		const rows = sessions.map(({ id }) => ({ session: id, concurrent: concurrencyBucket(peaks.get(id) ?? 1) }));
		return { measured, rows };
	},
};
