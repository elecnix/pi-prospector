/**
 * revive-chains — the waste of driving a back-and-forth with a child agent.
 *
 * The `subagent` tool has no persistent multi-turn primitive: every exchange
 * with a child costs a full spawn → run to completion → persist → revive
 * lifecycle. In the parent transcript this appears as chains of consecutive
 * `Revived async subagent from <runId>.` tool results — each one individually a
 * *successful* call, so no failure analyzer ever sees it, even though N revives
 * of one child imply N−1 spawns that a persistent conversation would not have
 * paid. This analyzer makes the pattern visible and names the remedy.
 *
 * The second half is the cost half. A child's token burn lives in the child's
 * artifact metadata, not in the parent transcript, so orchestration-heavy
 * sessions look cheap parent-side exactly where delegation concentrates spend.
 * The node therefore carries a `usage_split` with `self` and `delegated`
 * columns kept deliberately apart — merging them would hide the very thing the
 * split exists to show.
 *
 * Residual limitations, stated rather than papered over:
 * - The artifact join is by run id within the session's *project* (see
 *   `getSubagentRunsForSession`), not by a recorded parent link, so the
 *   delegated column can in principle include a same-project run that another
 *   parent session revived. Run ids are uuids, so collisions are unlikely but
 *   the join is not a proof of parentage.
 * - A chain's final spawn creates a run whose id appears in no revive marker
 *   (nothing revived *from* it yet), so that run's usage is structurally
 *   unreachable here and counts as unattributed only if a marker names it —
 *   the delegated column is a floor, not a ceiling.
 * - `self` tokens come from the parent transcript's own usage rows via the
 *   same fold `token-units` uses; `self` cost is the de-duplicated recorded
 *   `cost_usd`, null when the transcript recorded none. Neither side is ever
 *   merged into the other, and no figure is invented.
 *
 * Deterministic: no LLM, no network. The remedy is prose about a host
 * capability (a persistent multi-turn conversation primitive, or routing
 * chat-loop workloads through intercom) — it never suggests installing
 * anything, because nothing installable fixes this.
 */

import type {
	Analyzer,
	AnalyzerDef,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	AnalysisResult,
	AnalysisUnit,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeConfigHash, shortHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { buildToolStream } from "../../tool-stream.js";
import { ORCHESTRATION_TOOLS } from "../../../sync/parser.js";
import { getSubagentRunsForSession } from "../../../db/queries.js";
import { foldSessionUnits, type UsageRow } from "../token-units/fold.js";
import { DEFAULT_REVIVE_CHAINS_CONFIG, type ReviveChainsConfig } from "./config.js";
import {
	chainLengthHistogram,
	detectReviveChains,
	rollupDelegatedUsage,
	type DelegatedUsageRollup,
	type ReviveChain,
} from "./detect.js";

export * from "./config.js";
export * from "./detect.js";

/** The remedy this analyzer proposes, verbatim in every node that carries one. */
export const REVIVE_CHAINS_REMEDY =
	"The workload pattern is short alternating exchanges with a single child agent, " +
	"each paid for as a fresh spawn → complete → persist → revive lifecycle. A persistent " +
	"multi-turn conversation primitive for the subagent tool — keep the child alive across " +
	"exchanges instead of reviving it per turn — or routing the chat loop through intercom " +
	"would remove the redundant spawns and their repeated context reload. This is a host " +
	"capability gap, not a missing package: nothing to install.";

const SELF_ROWS_SELECT =
	"SELECT id, role, timestamp, usage, model, provider_message_id, cost_usd " +
	"FROM messages WHERE session_id = ? ORDER BY rowid ASC";

export const REVIVE_CHAINS_DEF: AnalyzerDef = {
	id: "revive-chains",
	label: "Revive Chains (deterministic)",
	description:
		"Detects chains of consecutive revived subagent results — the transcript signature of " +
		"driving a child agent without a persistent multi-turn primitive — reports chain length, " +
		"spawn count and redundant-spawn overhead per chain, and rolls the children's token and " +
		"cost usage (from subagent artifact metadata) into a self-vs-delegated split that is kept " +
		"visible rather than merged into the parent's own metrics. Proposes the remedy in prose; " +
		"never suggests installing anything. No LLM.",
	anchorSpan: "full_session",
	dependencies: [],
};

export const REVIVE_CHAINS_VERSION: AnalyzerVersion = {
	analyzerId: REVIVE_CHAINS_DEF.id,
	// 1.0: chain detection over the shared action stream, and the delegated
	// usage rollup joined by the revive markers' run ids.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/revive-chains/index.ts",
};

/** The parent session's own spend, read from its transcript — the `self` column. */
export interface SelfUsage {
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
	/** Billed parent calls after de-duplication by provider message id. */
	calls: number;
	/** Parent calls whose transcript recorded no usage — unknown, never zero. */
	calls_without_usage: number;
	/**
	 * De-duplicated recorded cost, or null when no parent call recorded one.
	 * De-duplicated the same way the token fold de-duplicates: one response,
	 * many content-block rows, counted once.
	 */
	cost_usd: number | null;
}

export interface ReviveChainsProperties {
	session_id: string;
	chain_count: number;
	chains: ReviveChain[];
	chain_length_histogram: Record<string, number>;
	/** Revived results across all chains. */
	revived_result_count: number;
	/** Sum of every chain's redundant spawns — the headline waste figure. */
	redundant_spawn_count: number;
	max_chain_length: number;
	usage_split: {
		self: SelfUsage;
		delegated: DelegatedUsageRollup;
	};
	/** The proposed remedy, in prose. Present when any chain reached the config threshold. */
	remedy: string | null;
}

function resolveConfig(raw: unknown): ReviveChainsConfig {
	return (raw as ReviveChainsConfig) ?? DEFAULT_REVIVE_CHAINS_CONFIG;
}

/**
 * The parent session's own usage, folded exactly the way `token-units` folds
 * it (same de-duplication, same weights) so the `self` column here can be
 * reconciled with that analyzer's totals rather than quietly disagreeing.
 */
function foldSelfUsage(sessionId: string, rows: SelfRow[]): { self: SelfUsage } {
	const folded = foldSessionUnits(
		sessionId,
		rows.map(({ cost_usd, ...rest }) => rest),
	);

	const seen = new Set<string>();
	let cost: number | null = null;
	for (const row of rows) {
		if (row.role !== "assistant") continue;
		const key = row.provider_message_id ?? row.id;
		if (seen.has(key)) continue;
		seen.add(key);
		if (typeof row.cost_usd === "number" && row.cost_usd > 0) {
			cost = (cost ?? 0) + row.cost_usd;
		}
	}

	return {
		self: {
			input: folded.totals.input,
			output: folded.totals.output,
			cache_read: folded.totals.cache_read,
			cache_write: folded.totals.cache_write,
			calls: folded.totals.calls,
			calls_without_usage: folded.coverage.calls_without_usage,
			cost_usd: cost,
		},
	};
}

/** A transcript row as the self-fold reads it. */
interface SelfRow extends UsageRow {
	cost_usd: number | null;
}

function emptySelfUsage(): SelfUsage {
	return {
		input: 0,
		output: 0,
		cache_read: 0,
		cache_write: 0,
		calls: 0,
		calls_without_usage: 0,
		cost_usd: null,
	};
}

export const reviveChainsAnalyzer: Analyzer = {
	def: REVIVE_CHAINS_DEF,
	version: REVIVE_CHAINS_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: REVIVE_CHAINS_DEF.id,
		configHash: computeConfigHash(DEFAULT_REVIVE_CHAINS_CONFIG),
		configJson: DEFAULT_REVIVE_CHAINS_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		if (ctx.messages.length === 0) return [];
		const stream = buildToolStream(ctx.messages);
		// No orchestration traffic → no chains, and the rollup has no markers to
		// join on. A session that never talked to a child gets no node.
		if (!stream.invocations.some((i) => ORCHESTRATION_TOOLS.includes(i.name))) return [];

		// The parent's own usage fold happens here, in plan, because the run
		// context carries no database handle — the same trade `token-units` makes
		// when it stashes its folded totals in `unit.meta`. The stash is part of
		// the unit's identity inputs (via the fingerprint below), so a re-sync
		// that backfills parent usage produces a fresh unit rather than leaving a
		// stale self column standing.
		const selfRows = (await ctx.db.prepare(SELF_ROWS_SELECT).all(ctx.sessionId)) as SelfRow[];
		const { self } = foldSelfUsage(ctx.sessionId, selfRows);

		// Identity folds in the chain-bearing content, not merely which messages
		// exist: a re-sync that classifies a previously unclassified subagent
		// result (or ingests a child artifact's usage) changes the inputs, and the
		// unit must re-identify as missing and recompute rather than keep serving
		// a conclusion drawn from thinner data.
		const childRuns = await getSubagentRunsForSession(ctx.db, ctx.sessionId);

		const fingerprint = shortHash(
			[
				...stream.invocations
					.filter((i) => ORCHESTRATION_TOOLS.includes(i.name))
					.map((i) =>
						[
							i.ordinal,
							i.name,
							i.outcome?.subagent?.status ?? "",
							i.outcome?.subagent?.runId ?? "",
							i.outcome?.messageId ?? i.messageId,
						].join(":"),
					),
				...childRuns.map((r) => `c:${r.run_id}:${r.usage ?? ""}:${r.file_mtime}`),
				...selfRows.map((r) => `u:${r.id}:${r.usage ?? ""}:${r.cost_usd ?? ""}`),
				`n:${stream.coverage.toolCallCount}`,
			].join("\n"),
		);

		const sources: SourceRef[] = [{ kind: "session", id: `${ctx.sessionId}#revive-chains=${fingerprint}` }];
		return [
			{
				sources,
				sourceSetHash: shortHash(`revive-chains(${ctx.sessionId}|${fingerprint})`),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
				meta: { self_usage: self as unknown as Record<string, unknown> },
			},
		];
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		const stream = buildToolStream(messages);
		const chains = detectReviveChains(stream);
		const childRuns = await ctx.getSubagentRuns(ctx.sessionId);
		const delegated = rollupDelegatedUsage(chains, childRuns);

		// Computed in plan() — see the note there. A unit planned by an older
		// version without the stash still renders honestly: the self column reads
		// as all-zero-calls with null cost rather than being invented.
		const self = (unit.meta?.["self_usage"] as SelfUsage | undefined) ?? emptySelfUsage();

		const revivedResultCount = chains.reduce((sum, c) => sum + c.length, 0);
		const redundantSpawns = chains.reduce((sum, c) => sum + c.redundant_spawns, 0);
		const maxChainLength = chains.reduce((max, c) => Math.max(max, c.length), 0);
		const proposes = maxChainLength >= config.minChainLength;

		const properties: ReviveChainsProperties = {
			session_id: ctx.sessionId,
			chain_count: chains.length,
			chains,
			chain_length_histogram: chainLengthHistogram(chains),
			revived_result_count: revivedResultCount,
			redundant_spawn_count: redundantSpawns,
			max_chain_length: maxChainLength,
			usage_split: { self, delegated },
			remedy: proposes ? REVIVE_CHAINS_REMEDY : null,
		};

		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
		];
		// Anchor each revived result's carrying message, so a chain can be walked
		// back to the exact calls that wasted the spawns.
		let ordinal = 1;
		const anchored = new Set<string>();
		for (const chain of chains) {
			for (const id of chain.message_ids) {
				if (anchored.has(id)) continue;
				anchored.add(id);
				edges.push({ toRefKind: REF_KINDS.MESSAGE, toRefId: id, edgeKind: EDGE_KINDS.ANCHORS, ordinal: ordinal++ });
			}
		}

		return {
			nodeKind: proposes ? "proposal" : "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			edges,
		};
	},
};
