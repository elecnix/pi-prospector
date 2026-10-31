import type { Bucket, Distribution, DistributionUnit, Withheld } from "./schema.js";

/**
 * The minimum-group guard. Every figure a fingerprint publishes rests on at
 * least `min` sessions, or it is merged into a neighbour, folded into `other`,
 * or withheld. These helpers are pure so the rule can be tested without a
 * database.
 */

export const WITHHELD: Withheld = { status: "withheld", reason: "below-min-group-size" };

/** The q-quantile of `values` (0 <= q <= 1), interpolating between neighbours. */
export function quantile(values: readonly number[], q: number): number {
	if (values.length === 0) throw new Error("quantile of no values");
	const sorted = [...values].sort((a, b) => a - b);
	const position = (sorted.length - 1) * q;
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	const lowerValue = sorted[lower]!;
	const upperValue = sorted[upper]!;
	return round(lowerValue + (upperValue - lowerValue) * (position - lower));
}

function round(n: number): number {
	return Math.round(n * 100) / 100;
}

/**
 * Spread `values` over the buckets that `edges` open, then merge any bucket
 * holding between 1 and `min - 1` sessions into its smaller neighbour until
 * none is left. Merging joins neighbours, so the buckets stay contiguous and an
 * empty bucket stays empty: a zero says nothing about any one session.
 */
export function distribution(values: readonly number[], edges: readonly number[], unit: DistributionUnit, min: number): Distribution {
	if (values.length < min) return WITHHELD;
	let buckets: Bucket[] = edges.map((from, i) => ({ from, to: edges[i + 1] ?? null, sessions: 0 }));
	for (const value of values) {
		let index = 0;
		for (let i = 0; i < edges.length; i++) if (value >= edges[i]!) index = i;
		buckets[index]!.sessions++;
	}
	for (;;) {
		let smallest = -1;
		for (let i = 0; i < buckets.length; i++) {
			const n = buckets[i]!.sessions;
			if (n > 0 && n < min && (smallest === -1 || n < buckets[smallest]!.sessions)) smallest = i;
		}
		if (smallest === -1 || buckets.length === 1) break;
		const left = buckets[smallest - 1];
		const right = buckets[smallest + 1];
		const withLeft = left !== undefined && (right === undefined || left.sessions <= right.sessions);
		const at = withLeft ? smallest - 1 : smallest;
		const a = buckets[at]!;
		const b = buckets[at + 1]!;
		buckets = [...buckets.slice(0, at), { from: a.from, to: b.to, sessions: a.sessions + b.sessions }, ...buckets.slice(at + 2)];
	}
	return {
		status: "ok",
		sessions: values.length,
		unit,
		p50: quantile(values, 0.5),
		p90: quantile(values, 0.9),
		buckets,
	};
}

/** A group before the guard: the sessions it came from are kept so a union can be counted. */
export interface RawGroup<K extends string> {
	key: K;
	count: number;
	sessionIds: ReadonlySet<string>;
}

/**
 * Keep the groups drawn from at least `min` sessions. Fold the rest into
 * `other`, which is published only when it too reaches `min`; a session in two
 * folded groups counts once.
 */
export function guardGroups<K extends string>(
	groups: readonly RawGroup<K>[],
	min: number,
	otherKey: K | "other" = "other",
): Array<{ key: K | "other"; count: number; sessions: number }> {
	const kept: Array<{ key: K | "other"; count: number; sessions: number }> = [];
	let otherCount = 0;
	const otherSessions = new Set<string>();
	const folded: RawGroup<K>[] = [];
	for (const group of groups) {
		if (group.sessionIds.size >= min && group.key !== otherKey) kept.push({ key: group.key, count: group.count, sessions: group.sessionIds.size });
		else folded.push(group);
	}
	for (const group of folded) {
		otherCount += group.count;
		for (const id of group.sessionIds) otherSessions.add(id);
	}
	if (otherSessions.size >= min) kept.push({ key: otherKey, count: otherCount, sessions: otherSessions.size });
	return kept;
}
