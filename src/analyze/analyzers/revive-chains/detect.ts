/**
 * The deterministic detection and rollup arithmetic for revive chains.
 *
 * A revive chain is a maximal run of *consecutive* subagent toolResults whose
 * classified outcome is `revived` — consecutive in the session's action stream
 * (see `tool-stream.ts`), where adjacency means "no other tool call in
 * between". Assistant turns that only carry text do not break a chain: the
 * parent thinking between two revives is the normal shape of the pattern. Any
 * other invocation — a different tool, or a subagent call whose result
 * classified as `completed` or `child_failed` — ends the chain, because the
 * stream no longer reads as one back-and-forth with a single child.
 *
 * Chain length L implies L spawns for one logical child conversation (each
 * revive re-pays the spawn → run → persist → revive lifecycle), so the
 * redundant-spawn estimate is L − 1. The initial spawn that started the
 * conversation is not itself a revive marker, so it is not counted — the
 * estimate is therefore conservative, never inflated.
 *
 * Usage rollup joins each revived marker's run id to the `subagent_runs`
 * artifact rows available in the analyzer context. Unrecorded values stay
 * null, and a marker whose run has no artifact row counts as *unattributed*,
 * never as zero.
 */

import type { SubagentRunRow } from "../../types.js";
import type { ToolStream } from "../../tool-stream.js";
import { ORCHESTRATION_TOOLS } from "../../../sync/parser.js";
import { Type, type Static } from "typebox";

/** One maximal run of consecutive revived subagent results. */
export const ReviveChain = Type.Object({
	/** Consecutive revived results in the chain. */
	length: Type.Number(),
	/** Spawns this chain implies: one per revive. Equals `length`. */
	spawn_count: Type.Number(),
	/** Spawns a persistent multi-turn primitive would have saved: `length - 1`. */
	redundant_spawns: Type.Number(),
	/**
	 * The run id each revived marker names — the run the call resumed *from*,
	 * in stream order. The final spawn's new run id appears only if the chain
	 * continued past it, so the last spawn of a chain is typically not listed.
	 */
	run_ids: Type.Array(Type.String()),
	/** Messages that carried the revived results, in stream order. */
	message_ids: Type.Array(Type.String()),
	/** Stream ordinal of the chain's first revived call. */
	first_ordinal: Type.Number(),
	/** Stream ordinal of the chain's last revived call. */
	last_ordinal: Type.Number(),
});
export type ReviveChain = Static<typeof ReviveChain>;

/**
 * Find every maximal run of consecutive revived subagent results in the
 * session's action stream. Chains are returned in stream order.
 */
export function detectReviveChains(stream: ToolStream): ReviveChain[] {
	const chains: ReviveChain[] = [];

	let current: ReviveChain | null = null;
	for (const inv of stream.invocations) {
		const revived =
			ORCHESTRATION_TOOLS.includes(inv.name) &&
			inv.outcome !== null &&
			inv.outcome.subagent?.status === "revived";

		if (!revived) {
			// Any other invocation — different tool, or a subagent result that
			// completed or reported a child failure — ends the current chain.
			current = null;
			continue;
		}

		if (current === null) {
			current = {
				length: 0,
				spawn_count: 0,
				redundant_spawns: 0,
				run_ids: [],
				message_ids: [],
				first_ordinal: inv.ordinal,
				last_ordinal: inv.ordinal,
			};
			chains.push(current);
		}
		current.length += 1;
		current.spawn_count += 1;
		current.last_ordinal = inv.ordinal;
		if (inv.outcome?.subagent?.runId) current.run_ids.push(inv.outcome.subagent.runId);
		current.message_ids.push(inv.outcome?.messageId ?? inv.messageId);
	}

	for (const c of chains) {
		c.redundant_spawns = c.length - 1;
	}
	return chains;
}

/** Histogram of chain lengths, keyed by length as a string (JSON-object friendly). */
export function chainLengthHistogram(chains: readonly ReviveChain[]): Record<string, number> {
	const histogram: Record<string, number> = {};
	for (const c of chains) {
		const key = String(c.length);
		histogram[key] = (histogram[key] ?? 0) + 1;
	}
	return histogram;
}

/** One usage field's rollup: the summed recorded value, or null when no run recorded it. */
/**
 * A rolled-up value plus how many runs backed it, so a small total resting on
 * one run reads differently from a small total resting on twenty.
 */
export const RolledFieldValue = Type.Object({
	value: Type.Union([Type.Number(), Type.Null()]),
	/** Attributed runs whose usage recorded this field. */
	recorded_runs: Type.Number(),
});
export type RolledFieldValue = Static<typeof RolledFieldValue>;

/** Child-side usage attributed to revive chains, kept strictly apart from the parent's own spend. */
export const DelegatedUsageRollup = Type.Object({
	/** Runs whose artifact row was found and read. */
	attributed_runs: Type.Number(),
	/**
	 * Revived markers whose run id matched no artifact row — the run is counted
	 * as unattributed rather than contributing zero.
	 */
	unattributed_runs: Type.Number(),
	/** Runs with an artifact row but no recorded (or parseable) usage object. */
	runs_without_usage: Type.Number(),
	/** Token and cost totals; a field is null when no attributed run recorded it. */
	input: RolledFieldValue,
	output: RolledFieldValue,
	cache_read: RolledFieldValue,
	cache_write: RolledFieldValue,
	cost_usd: RolledFieldValue,
	turns: RolledFieldValue,
});
export type DelegatedUsageRollup = Static<typeof DelegatedUsageRollup>;

/**
 * Aggregate the child usage behind every revive chain.
 *
 * Run ids are de-duplicated across chains first: a run resumed in two separate
 * chains is one child conversation's usage, and summing it twice would inflate
 * the delegated column. The artifact join is by run id against the rows the
 * framework hands the analyzer (project-scoped — see `getSubagentRunsForSession`).
 */
export function rollupDelegatedUsage(
	chains: readonly ReviveChain[],
	childRuns: readonly SubagentRunRow[],
): DelegatedUsageRollup {
	const byRunId = new Map<string, SubagentRunRow>();
	for (const r of childRuns) {
		if (!byRunId.has(r.run_id)) byRunId.set(r.run_id, r);
	}

	const seen = new Set<string>();
	let attributed = 0;
	let unattributed = 0;
	let runsWithoutUsage = 0;
	const fields: Record<"input" | "output" | "cacheRead" | "cacheWrite" | "cost" | "turns", RolledFieldValue> = {
		input: { value: null, recorded_runs: 0 },
		output: { value: null, recorded_runs: 0 },
		cacheRead: { value: null, recorded_runs: 0 },
		cacheWrite: { value: null, recorded_runs: 0 },
		cost: { value: null, recorded_runs: 0 },
		turns: { value: null, recorded_runs: 0 },
	};

	for (const chain of chains) {
		for (const runId of chain.run_ids) {
			if (seen.has(runId)) continue;
			seen.add(runId);

			const row = byRunId.get(runId);
			if (!row) {
				unattributed += 1;
				continue;
			}
			attributed += 1;

			if (!row.usage) {
				runsWithoutUsage += 1;
				continue;
			}
			let usage: Record<string, unknown>;
			try {
				usage = JSON.parse(row.usage) as Record<string, unknown>;
			} catch {
				// A malformed blob is stored verbatim at ingest by design; reading it
				// is where the malformation surfaces. The run stays attributed (its
				// artifact exists) but contributes no numbers.
				runsWithoutUsage += 1;
				continue;
			}

			for (const [key, target] of [
				["input", fields.input],
				["output", fields.output],
				["cacheRead", fields.cacheRead],
				["cacheWrite", fields.cacheWrite],
				["cost", fields.cost],
				["turns", fields.turns],
			] as const) {
				const v = usage[key];
				if (typeof v !== "number" || !Number.isFinite(v)) continue;
				target.value = (target.value ?? 0) + v;
				target.recorded_runs += 1;
			}
		}
	}

	return {
		attributed_runs: attributed,
		unattributed_runs: unattributed,
		runs_without_usage: runsWithoutUsage,
		input: fields.input,
		output: fields.output,
		cache_read: fields.cacheRead,
		cache_write: fields.cacheWrite,
		cost_usd: fields.cost,
		turns: fields.turns,
	};
}
