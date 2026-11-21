import type { FingerprintRow } from "./contributor.js";

/**
 * Labels for the buckets an analyzer writes into its node, keyed by each
 * bucket's upper bound and `null` for the overflow bucket. The labels follow the
 * analyzer's default bounds, which is what a fingerprint publishes.
 */
export function bucketLabels(bounds: readonly number[], format: (bound: number) => string): ReadonlyMap<number | null, string> {
	const labels = new Map<number | null, string>(bounds.map((bound, i) => [bound, `${i === 0 ? "0" : format(bounds[i - 1]!)}-${format(bound)}`]));
	const last = bounds.at(-1);
	labels.set(null, last === undefined ? "all" : `over-${format(last)}`);
	return labels;
}

/**
 * One row per bucket item, labelled through `labels`. A session whose bucket
 * bounds are not exactly the labelled ones (its config set other bounds) counts
 * every bucket under `other`, never under a label that means something else.
 * Each item row carries `le`, the bucket's upper bound, and `count`. A session
 * with several current nodes has each bound once per node, so the check
 * compares the set of bounds.
 */
export function labelBuckets(items: readonly FingerprintRow[], labels: ReadonlyMap<number | null, string>, dimension: string): FingerprintRow[] {
	const bySession = new Map<string, FingerprintRow[]>();
	for (const item of items) {
		const session = String(item["session"]);
		bySession.set(session, [...(bySession.get(session) ?? []), item]);
	}
	const rows: FingerprintRow[] = [];
	for (const [session, own] of bySession) {
		const bounds = own.map((b) => (typeof b["le"] === "number" ? b["le"] : null));
		const distinct = new Set(bounds);
		const standard = distinct.size === labels.size && [...distinct].every((b) => labels.has(b));
		for (const [i, b] of own.entries()) rows.push({ session, [dimension]: standard ? labels.get(bounds[i]!)! : "other", count: b["count"] ?? null });
	}
	return rows;
}
