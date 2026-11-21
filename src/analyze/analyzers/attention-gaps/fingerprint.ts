import type { FingerprintContributor } from "../../../fingerprint/contributor.js";
import { bucketLabels, labelBuckets } from "../../../fingerprint/buckets.js";
import { DEFAULT_ATTENTION_GAPS_CONFIG } from "./config.js";

/** `10s`, `1m`, `2h`: a bound in seconds, in the largest unit that divides it. */
function duration(seconds: number): string {
	if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

/** The default wait buckets: `0-10s`, `10s-1m`, `1m-5m`, `5m-30m`, `30m-2h`, `over-2h`. */
const WAIT_LABELS = bucketLabels(DEFAULT_ATTENTION_GAPS_CONFIG.bucketBoundsSeconds, duration);

/**
 * How long the agent waited for a person: from the agent's last activity to
 * the next message a person typed. Timed from the host's timestamps, so
 * objective. A session with no typed message is measured and waits on no one.
 */
export const attentionGapsFingerprint: FingerprintContributor = {
	def: {
		id: "attention",
		label: "Attention gaps",
		description:
			"The wait from the agent's last activity to each message a person typed: typed messages, gaps, sessions that waited on a person at all, and gaps by length. Only messages settled as typed count; the clock stops when the message is sent, not when the person started reading.",
		kind: "objective",
		analyzers: ["attention-gaps", "message-origin"],
		measures: [
			{ kind: "total", id: "typedMessages", metric: "attention-gaps.wait", field: "typed" },
			{ kind: "total", id: "gaps", metric: "attention-gaps.wait", field: "gaps" },
			{ kind: "sessions", id: "sessionsWaiting", metric: "attention-gaps.waiting-sessions", field: "typed" },
			{ kind: "groups", id: "byWait", metric: "attention-gaps.wait", dimensions: { wait: [...WAIT_LABELS.values()] }, countField: "count" },
		],
	},
	async read(ctx) {
		const measured = new Set(await ctx.runs("attention-gaps"));
		const ours = (r: { session?: unknown }) => measured.has(String(r.session));
		const totals = await ctx.nodes("attention-gaps", { typed: "$.typed_message_count", gaps: "$.gap_count" });
		const buckets = await ctx.items("attention-gaps", "$.buckets", { le: "$.le_seconds", count: "$.count" });
		return { measured: [...measured], rows: [...totals.filter(ours), ...labelBuckets(buckets.filter(ours), WAIT_LABELS, "wait")] };
	},
};
