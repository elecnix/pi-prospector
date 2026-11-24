import type { FingerprintContributor } from "../../../fingerprint/contributor.js";
import { metricValues } from "../../metrics/values.js";
import { mergeIntervals, type Interval } from "./detect.js";
import { metrics } from "./metrics.js";

/** The fixed buckets of a session's peak concurrency. */
export const CONCURRENCY_BUCKETS = ["1", "2", "3-4", "5-9", "10-19", "20-49", "50-or-more"] as const;

/** The four six-hour parts of the local day, from midnight. */
export const PARTS_OF_DAY = metricValues(metrics, "activity-windows.part-of-day");

const MINUTE = 60_000;
const PART = 6 * 60 * MINUTE;
const DAY = 24 * 60 * MINUTE;

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
 * Active minutes in each part of the local day. `offsetMinutes` gives the
 * local clock's offset from UTC at an instant (east positive), so the split
 * follows a daylight-saving change.
 */
export function minutesByPartOfDay(windows: readonly Interval[], offsetMinutes: (at: number) => number): Record<string, number> {
	const ms = new Map<string, number>();
	for (const [start, end] of windows) {
		let at = start;
		while (at < end) {
			const offset = offsetMinutes(at) * MINUTE;
			const local = at + offset;
			const part = PARTS_OF_DAY[Math.floor((((local % DAY) + DAY) % DAY) / PART)]!;
			const next = Math.min(end, Math.floor(local / PART) * PART + PART - offset);
			ms.set(part, (ms.get(part) ?? 0) + (next - at));
			at = next;
		}
	}
	return Object.fromEntries([...ms].map(([part, n]) => [part, Math.round(n / MINUTE)]));
}

/** The offset of the clock this process runs on. */
const localOffset = (at: number): number => -new Date(at).getTimezoneOffset();

/**
 * When and how parallel a person works, from each session's activity windows.
 * Counted from the host's timestamps, so the figures are objective. Concurrency
 * is read across the sessions in the fingerprint's scope, at read time, as the
 * `concurrency` output reads it.
 */
export const activityWindowsFingerprint: FingerprintContributor = {
	def: {
		id: "activityWindows",
		label: "Activity windows",
		description:
			"Sessions by the most sessions active at the same moment while they were, which shows how many agents a person runs in parallel, and active minutes by part of the day: night (0 to 6), morning (6 to 12), afternoon (12 to 18) and evening (18 to 24), on the clock of the machine that built the fingerprint. The parts are six hours wide so they do not reveal a time zone. From timestamps, not from language.",
		kind: "objective",
		analyzers: ["activity-windows"],
		measures: [
			{ kind: "groups", id: "byPeakConcurrency", metric: "activity-windows.concurrency", dimensions: { concurrent: [...CONCURRENCY_BUCKETS] } },
			{ kind: "groups", id: "minutesByPartOfDay", metric: "activity-windows.part-of-day", dimensions: { partOfDay: PARTS_OF_DAY }, countField: "minutes" },
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
		const rows = sessions.flatMap(({ id, windows }) => [
			{ session: id, concurrent: concurrencyBucket(peaks.get(id) ?? 1) },
			...Object.entries(minutesByPartOfDay(windows, localOffset)).map(([partOfDay, minutes]) => ({ session: id, partOfDay, minutes })),
		]);
		return { measured, rows };
	},
};
