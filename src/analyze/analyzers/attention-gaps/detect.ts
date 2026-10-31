/**
 * Attention gaps: how long the agent waited for a person.
 *
 * A **gap** is the time from the agent's last activity before a user-role message
 * to that message. The agent's last activity is the latest assistant message or
 * tool result before it: a harness notification filed under the user role is not
 * the agent finishing, and the agent had been waiting since before it.
 *
 * Only a message the person *typed* is attention. A prompt another agent wrote, a
 * harness notification, and pasted material say nothing about when the person
 * looked at the screen. The origin comes from the `message-origin` nodes, and a
 * node that is `decided: false` carries a provisional `typed` label that no rule
 * settled, so its gaps are counted apart (`undecided_gap_count`) and never enter
 * the statistics.
 *
 * A gap needs a timestamp on both ends. A typed message with none, or with no
 * earlier agent activity (the first turn), has no gap and is counted, never
 * measured as zero.
 */

import type { MessageRow } from "../../types.js";
import { DEFAULT_ATTENTION_GAPS_CONFIG, type AttentionGapsConfig } from "./config.js";

/** What the attention reading needs from a message-origin node. */
export interface OriginRead {
	origin: "typed" | "pasted" | "agent" | "notification";
	decided: boolean;
}

export interface GapBucket {
	/** Upper bound in seconds, or null for the overflow bucket. */
	le_seconds: number | null;
	count: number;
}

export interface AttentionScan {
	/** Typed messages whose origin a rule or the model settled. */
	typed_message_count: number;
	/** Messages whose label is provisional. */
	undecided_message_count: number;
	/** Settled typed messages with a measured gap. */
	gap_count: number;
	/** Settled typed messages with no gap: the first turn, or a missing timestamp. */
	unmeasured_typed_count: number;
	/** Measured gaps to undecided messages, kept out of the statistics. */
	undecided_gap_count: number;
	sum_seconds: number;
	median_seconds: number | null;
	p90_seconds: number | null;
	max_seconds: number | null;
	buckets: GapBucket[];
	longest: Array<{ user_message_id: string; seconds: number }>;
}

function nearestRank(sorted: readonly number[], p: number): number | null {
	if (sorted.length === 0) return null;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

function timeOf(m: MessageRow): number | null {
	if (m.timestamp === null) return null;
	const t = Date.parse(m.timestamp);
	return Number.isFinite(t) ? t : null;
}

/** The attention gaps of one session. */
export function scanAttention(
	messages: readonly MessageRow[],
	origins: ReadonlyMap<string, OriginRead>,
	config: AttentionGapsConfig = DEFAULT_ATTENTION_GAPS_CONFIG,
): AttentionScan {
	let typed = 0;
	let undecided = 0;
	let unmeasured = 0;
	let undecidedGaps = 0;
	const measured: Array<{ id: string; seconds: number }> = [];

	let agentLastAt: number | null = null;
	for (const m of messages) {
		const origin = origins.get(m.id);
		if (origin !== undefined) {
			const settledTyped = origin.decided && origin.origin === "typed";
			if (settledTyped) typed++;
			if (!origin.decided) undecided++;
			if (settledTyped || !origin.decided) {
				const at = timeOf(m);
				const seconds = at !== null && agentLastAt !== null && at >= agentLastAt ? (at - agentLastAt) / 1000 : null;
				if (!origin.decided) {
					if (seconds !== null) undecidedGaps++;
				} else if (seconds === null) {
					unmeasured++;
				} else {
					measured.push({ id: m.id, seconds });
				}
			}
		}
		if (m.role === "assistant" || m.role === "toolResult") {
			const at = timeOf(m);
			if (at !== null) agentLastAt = at;
		}
	}

	const seconds = measured.map((g) => g.seconds).sort((a, b) => a - b);
	const bounds = [...config.bucketBoundsSeconds].sort((a, b) => a - b);
	const buckets: GapBucket[] = [...bounds.map((le) => ({ le_seconds: le as number | null, count: 0 })), { le_seconds: null, count: 0 }];
	for (const s of seconds) {
		const bucket = buckets.find((b) => b.le_seconds === null || s <= b.le_seconds);
		if (bucket) bucket.count++;
	}

	const round = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
	return {
		typed_message_count: typed,
		undecided_message_count: undecided,
		gap_count: measured.length,
		unmeasured_typed_count: unmeasured,
		undecided_gap_count: undecidedGaps,
		sum_seconds: round(seconds.reduce((n, s) => n + s, 0)) ?? 0,
		median_seconds: round(nearestRank(seconds, 0.5)),
		p90_seconds: round(nearestRank(seconds, 0.9)),
		max_seconds: round(seconds[seconds.length - 1] ?? null),
		buckets,
		longest: [...measured]
			.sort((a, b) => b.seconds - a.seconds || a.id.localeCompare(b.id))
			.slice(0, config.longestCap)
			.map((g) => ({ user_message_id: g.id, seconds: round(g.seconds) ?? 0 })),
	};
}
