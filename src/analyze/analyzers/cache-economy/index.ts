/**
 * cache-economy — a deterministic, session-level analyzer that measures
 * prompt-cache behaviour.
 *
 * Motivation: prompt caching is the one cost lever this repo measures nothing
 * about, and it is the one where a wrong setting is invisible. A cache read
 * costs a fraction of a fresh input token; a cache write costs *more* than one.
 * On a real corpus ~94% of billed tokens are cacheRead, so a session that
 * silently re-pays the full input rate — with near-zero cache reads — burns
 * most of its cost on a cache that never hits (measured at ~90% of spend on one
 * route). Every other analyzer calls that session healthy, because they all
 * treat cacheRead as just part of "input".
 *
 * This analyzer measures, per billed assistant turn, the cache hit ratio
 *     hitRatio = cacheRead / (cacheRead + cacheWrite + input)
 * and the inter-turn wall-clock gap, then separates the two causes of a cold
 * miss, which have opposite fixes:
 *
 *   - TTL expiry — the gap since the previous turn exceeded the cache lifetime,
 *     so the prefix was rebuilt from scratch. Fix is behavioural (keep the
 *     session warm, or accept the write and stop paying twice).
 *   - Prefix instability — the cache missed even though the turn was prompt.
 *     Something near the front of the context changed between turns (a
 *     re-ordered tool schema, a mutating system preamble, an injected
 *     timestamp). Fix is structural and, once identified, permanent.
 *
 * A third finding falls out for free: write churn — a cache write with no
 * subsequent read before the session ends. That is pure loss, countable exactly.
 *
 * Coverage is stated, never assumed. An assistant turn that recorded no usage
 * is *unbilled* (unknown), distinct from a turn that recorded a genuine zero
 * (meaured). `cost_usd` is the billed total of the whole turn — there is no
 * per-bucket dollar figure in the index yet — so any dollar figure here is a
 * LOWER BOUND of the cache-specific waste, labelled as such. All numbers are
 * deterministic; no LLM.
 */

import type {
	Analyzer,
	AnalyzerDef,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	AnalysisResult,
	AnalysisUnit,
	SourceRef,
} from "../../types.js";
import { computeConfigHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";

export const CACHE_ECONOMY_DEF: AnalyzerDef = {
	id: "cache-economy",
	label: "Cache Economy (deterministic)",
	description:
		"Measures per-turn prompt-cache hit ratio, separates TTL-expiry from prefix-instability cold misses, and counts write churn. Flags sessions that silently pay the full input rate with near-zero cache reads. No LLM.",
	anchorSpan: "full_session",
	dependencies: [],
};

export const CACHE_ECONOMY_VERSION: AnalyzerVersion = {
	analyzerId: CACHE_ECONOMY_DEF.id,
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/cache-economy/index.ts",
};

// ── types ──

type UsageRow = {
	role: string;
	timestamp: string | null;
	usage: string | null;
	model: string | null;
	cost_usd: number | null;
};

export type CacheClassification = "hit" | "cold-ttl" | "cold-prefix" | "cold-start" | "partial" | "unbilled";

export interface CacheTurn {
	/** Message row ordinal (billed assistant turns only). */
	ordinal: number;
	/** Serving model, or null when unrecorded. */
	model: string | null;
	/** Fresh input tokens (usage.input). */
	inputTokens: number;
	/** Cache-read tokens (usage.cacheRead). */
	cacheReadTokens: number;
	/** Cache-write tokens (usage.cacheWrite). */
	cacheWriteTokens: number;
	/** Output tokens (usage.output). */
	outputTokens: number;
	/** Total billed tokens (usage.totalTokens). */
	totalTokens: number;
	/** cacheRead / (cacheRead + cacheWrite + input), in [0,1]. NaN when unbilled. */
	hitRatio: number | null;
	/** Wall-clock seconds since the previous billed turn, or null when first/unparseable. */
	gapSeconds: number | null;
	/** Billed dollar cost of the whole turn, or null when unrecorded. */
	costUsd: number | null;
	classification: CacheClassification;
}

export interface CacheEconomyProperties {
	session_id: string;
	/** Per-billed-turn measurements, in order. */
	turns: CacheTurn[];
	/** Coverage: how many billed turns recorded usage vs recorded none. */
	usage_recorded_turn_count: number;
	unbilled_turn_count: number;
	/** Coverage: how many billed turns carried a billed dollar cost vs not. */
	priced_turn_count: number;
	unpriced_turn_count: number;
	/** Aggregate hit ratio over the whole session: totalCacheRead / (totalCacheRead + totalCacheWrite + totalInput). Null when no usage was recorded at all. */
	aggregate_hit_ratio: number | null;
	aggregate_input_tokens: number;
	aggregate_cache_read_tokens: number;
	aggregate_cache_write_tokens: number;
	/** Raw tallies per classification. */
	classification_counts: Record<CacheClassification, number>;
	/** Cache writes that were never followed by any cache read before the session ended (pure loss), in tokens. */
	write_churn_tokens: number;
	/**
	 * The billed dollar cost of the turns classified as cold misses (ttl + prefix),
	 * or null when none of them could be priced. Money is never guessed.
	 * There is no per-bucket dollar figure (only `usage.cost.total`), so this is a
	 * LOWER BOUND of the cache-specific waste — it is the whole turn's bill, not
	 * the cacheRead dollars in particular — and is labelled as such. See
	 * `cold_priced_turn_count`/`cold_turn_count` for coverage.
	 */
	cold_miss_cost_usd: number | null;
	/** Of the cold-miss turns, how many carried a recorded cost. */
	cold_priced_turn_count: number;
	/** Total cold-miss turns (ttl + prefix). */
	cold_turn_count: number;
}

// ── config ──

export interface CacheEconomyConfig {
	/** Ephemeral cache TTL in seconds (Claude's 5-minute default). */
	ttlSeconds: number;
	/** A turn must have at least this many fresh input tokens to be a candidate cold miss. */
	largeInputTokens: number;
	/** A turn whose cacheRead is below this is treated as having missed the cache. */
	coldCacheReadTokens: number;
	/** A turn whose hitRatio is at or above this counts as a healthy cache hit. */
	hitRatioThreshold: number;
}

export const DEFAULT_CACHE_ECONOMY_CONFIG: CacheEconomyConfig = {
	/** Claude ephemeral cache lifetime (5 minutes). */
	ttlSeconds: 300,
	/** Below this fresh-input size a cold cache is uninteresting (a tiny fresh request). */
	largeInputTokens: 5000,
	/** A turn re-reading fewer than this many tokens has effectively missed the cache. */
	coldCacheReadTokens: 100,
	/** hitRatio >= 0.5 counts as a hit. */
	hitRatioThreshold: 0.5,
};

const MIN_COLD_MISS_TURNS_FOR_PROPOSAL = 2;

// ── pure measurement ──

export function classifyTurn(
	t: {
		inputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		hitRatio: number | null;
		gapSeconds: number | null;
		isFirstBilled: boolean;
		cfg: CacheEconomyConfig;
	},
): CacheClassification {
	// No usage recorded at all → not a billed turn; we cannot measure it.
	if (t.hitRatio === null || Number.isNaN(t.hitRatio)) return "unbilled";

	if (t.hitRatio >= t.cfg.hitRatioThreshold) return "hit";

	// Cold miss candidate: cacheRead near zero with a meaningfully large fresh input.
	const cold = t.cacheReadTokens < t.cfg.coldCacheReadTokens && t.inputTokens >= t.cfg.largeInputTokens;
	if (cold) {
		// The first billed turn always rebuilds the prefix from a cold start — expected, not a defect.
		if (t.isFirstBilled) return "cold-start";
		// Cache missed despite a prompt turn → classify by the wall-clock gap.
		if (t.gapSeconds !== null && t.gapSeconds > t.cfg.ttlSeconds) return "cold-ttl";
		return "cold-prefix";
	}

	// In between a clean hit and a clear cold miss: a partial read.
	return "partial";
}

/**
 * Measure one session's cache behaviour. Exported for unit testing.
 */
export function measureCache(rows: UsageRow[], cfg: CacheEconomyConfig): {
	turns: CacheTurn[];
	aggregate: {
		input: number;
		cacheRead: number;
		cacheWrite: number;
		aggregateHitRatio: number | null;
	};
} {
	const turns: CacheTurn[] = [];
	const billed: Array<{ index: number; inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number; totalTokens: number; timestamp: string | null; model: string | null; costUsd: number | null }> = [];

	for (let i = 0; i < rows.length; i++) {
		const r = rows[i]!;
		if (r.role !== "assistant" || !r.usage) continue;
		try {
			const u = JSON.parse(r.usage) as Record<string, number>;
			const input = u["input"] ?? 0;
			const output = u["output"] ?? 0;
			const cacheRead = u["cacheRead"] ?? 0;
			const cacheWrite = u["cacheWrite"] ?? 0;
			const total = u["totalTokens"] ?? input + output;
			if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) continue;
			billed.push({
				index: i,
				inputTokens: input,
				cacheReadTokens: cacheRead,
				cacheWriteTokens: cacheWrite,
				outputTokens: output,
				totalTokens: total,
				timestamp: r.timestamp,
				model: r.model,
				costUsd: r.cost_usd,
			});
		} catch {
			/* malformed usage → ignore, stays unbilled */
		}
	}

	// Prev billed timestamp for the wall-clock gap.
	for (let k = 0; k < billed.length; k++) {
		const b = billed[k]!;
		const prev = k > 0 ? billed[k - 1] : undefined;
		let gapSeconds: number | null = null;
		if (prev?.timestamp && b.timestamp) {
			const t0 = Date.parse(prev.timestamp);
			const t1 = Date.parse(b.timestamp);
			if (Number.isFinite(t0) && Number.isFinite(t1)) gapSeconds = (t1 - t0) / 1000;
		}
		const denom = b.cacheReadTokens + b.cacheWriteTokens + b.inputTokens;
		const hitRatio = denom > 0 ? b.cacheReadTokens / denom : null;
		const classification = classifyTurn({
			inputTokens: b.inputTokens,
			cacheReadTokens: b.cacheReadTokens,
			cacheWriteTokens: b.cacheWriteTokens,
			hitRatio,
			gapSeconds,
			isFirstBilled: k === 0,
			cfg,
		});
		turns.push({
			ordinal: b.index,
			model: b.model,
			inputTokens: b.inputTokens,
			cacheReadTokens: b.cacheReadTokens,
			cacheWriteTokens: b.cacheWriteTokens,
			outputTokens: b.outputTokens,
			totalTokens: b.totalTokens,
			hitRatio,
			gapSeconds,
			costUsd: b.costUsd,
			classification,
		});
	}

	let input = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	for (const t of turns) {
		input += t.inputTokens;
		cacheRead += t.cacheReadTokens;
		cacheWrite += t.cacheWriteTokens;
	}
	const denomAgg = cacheRead + cacheWrite + input;
	const aggregateHitRatio = denomAgg > 0 ? cacheRead / denomAgg : null;

	return {
		turns,
		aggregate: { input, cacheRead, cacheWrite, aggregateHitRatio },
	};
}

/** Count write churn: cache writes never followed by any read before session end. */
export function countWriteChurn(turns: CacheTurn[]): number {
	let churn = 0;
	for (let k = 0; k < turns.length; k++) {
		const t = turns[k]!;
		if (t.cacheWriteTokens <= 0) continue;
		let readAfter = false;
		for (let j = k + 1; j < turns.length; j++) {
			if (turns[j]!.cacheReadTokens > 0) {
				readAfter = true;
				break;
			}
		}
		if (!readAfter) churn += t.cacheWriteTokens;
	}
	return churn;
}

// ── analyzer ──

export const cacheEconomyAnalyzer: Analyzer = {
	def: CACHE_ECONOMY_DEF,
	version: CACHE_ECONOMY_VERSION,
	prompts: {},
	defaultConfig: {
		id: "",
		analyzerId: CACHE_ECONOMY_DEF.id,
		configHash: computeConfigHash(DEFAULT_CACHE_ECONOMY_CONFIG),
		configJson: DEFAULT_CACHE_ECONOMY_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		if (ctx.messages.length === 0) return [];

		const cfg = (ctx.config as unknown as CacheEconomyConfig) ?? DEFAULT_CACHE_ECONOMY_CONFIG;
		const rows = (await ctx.db
			.prepare("SELECT role, timestamp, usage, model, cost_usd FROM messages WHERE session_id = ? ORDER BY rowid ASC")
			.all(ctx.sessionId)) as UsageRow[];
		const result = measureSession(ctx.sessionId, rows, cfg);

		const sources: SourceRef[] = [{ kind: "session", id: ctx.sessionId }];
		return [
			{
				sources,
				sourceSetHash: `cache-economy:${ctx.sessionId}`,
				anchorKind: "session",
				anchorRef: ctx.sessionId,
				meta: { result },
			},
		];
	},

	analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): AnalysisResult {
		const cfg = (ctx.config.configJson as unknown as CacheEconomyConfig) ?? DEFAULT_CACHE_ECONOMY_CONFIG;
		const properties = (unit.meta?.["result"] as CacheEconomyProperties) ?? emptyProperties(ctx.sessionId);

		const proposals = buildProposals(properties, cfg);

		return {
			nodeKind: proposals.length > 0 ? "proposal" : "metric",
			contentJson: { ...properties, improvement_proposals: proposals },
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			edges: [
				{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
			],
		};
	},
};

function measureSession(sessionId: string, rows: UsageRow[], cfg: CacheEconomyConfig): CacheEconomyProperties {
	const { turns, aggregate } = measureCache(rows, cfg);
	const writeChurnTokens = countWriteChurn(turns);

	const counts: Record<CacheClassification, number> = {
		hit: 0,
		"cold-ttl": 0,
		"cold-prefix": 0,
		"cold-start": 0,
		partial: 0,
		unbilled: 0,
	};
	let usageRecorded = 0;
	let priced = 0;
	let coldCount = 0;
	let coldPriced = 0;
	let coldCost = 0;
	for (const t of turns) {
		counts[t.classification]++;
		usageRecorded++;
		if (typeof t.costUsd === "number" && Number.isFinite(t.costUsd) && t.costUsd > 0) priced++;
		if (t.classification === "cold-ttl" || t.classification === "cold-prefix") {
			coldCount++;
			if (typeof t.costUsd === "number" && Number.isFinite(t.costUsd) && t.costUsd > 0) {
				coldPriced++;
				coldCost += t.costUsd;
			}
		}
	}

	let unbilled = 0;
	for (const r of rows) if (r.role === "assistant") unbilled++;
	unbilled = Math.max(0, unbilled - usageRecorded);

	return {
		session_id: sessionId,
		turns,
		usage_recorded_turn_count: usageRecorded,
		unbilled_turn_count: unbilled,
		priced_turn_count: priced,
		unpriced_turn_count: usageRecorded - priced,
		aggregate_hit_ratio: aggregate.aggregateHitRatio,
		aggregate_input_tokens: aggregate.input,
		aggregate_cache_read_tokens: aggregate.cacheRead,
		aggregate_cache_write_tokens: aggregate.cacheWrite,
		classification_counts: counts,
		write_churn_tokens: writeChurnTokens,
		cold_miss_cost_usd: coldPriced > 0 ? coldCost : null,
		cold_priced_turn_count: coldPriced,
		cold_turn_count: coldCount,
	};
}

function emptyProperties(sessionId: string): CacheEconomyProperties {
	return measureSession(sessionId, [], DEFAULT_CACHE_ECONOMY_CONFIG);
}

interface RawProposal {
	target_type: string;
	title: string;
	summary: string;
	detail: string;
	evidence: string;
	confidence: number;
	severity: string;
}

export function buildProposals(p: CacheEconomyProperties, cfg: CacheEconomyConfig): RawProposal[] {
	const proposals: RawProposal[] = [];
	const coldCount = p.cold_turn_count;

	if (coldCount >= MIN_COLD_MISS_TURNS_FOR_PROPOSAL) {
		const ttl = p.classification_counts["cold-ttl"];
		const prefix = p.classification_counts["cold-prefix"];
		const costNote =
			p.cold_priced_turn_count > 0
				? ` ${p.cold_priced_turn_count}/${coldCount} priced turns sum to $${p.cold_miss_cost_usd!.toFixed(4)} (lower bound).`
				: " No priced cold turn in this session; money cost unknown.";
		proposals.push({
			target_type: "config",
			title: `Cold prompt cache: ${coldCount} turns rebuilt the prefix from scratch`,
			summary: `This session re-paid the full input rate on ${coldCount} turns: aggregate cache hit ratio ${p.aggregate_hit_ratio === null ? "unknown" : (p.aggregate_hit_ratio * 100).toFixed(0) + "%"}.${costNote}`,
			detail: `${ttl} of those misses followed a gap past the ${cfg.ttlSeconds}s cache TTL (TTL expiry — keep the session warm or accept the rebuild), and ${prefix} missed even though the turn was prompt (prefix instability — something near the front of the context changed between turns). The two have opposite fixes: behavioural vs structural.`,
			evidence: `aggregate hitRatio ${p.aggregate_hit_ratio === null ? "n/a" : (p.aggregate_hit_ratio * 100).toFixed(1) + "%"}; ${ttl} TTL expiry, ${prefix} prefix-instability; ${p.write_churn_tokens.toLocaleString()} write-churn tokens.`,
			confidence: 0.85,
			severity: "waste",
		});
	}

	if (p.classification_counts["cold-ttl"] > 0 && coldCount > 0) {
		proposals.push({
			target_type: "config",
			title: `TTL expiry: ${p.classification_counts["cold-ttl"]} turns missed cache after a gap past ${cfg.ttlSeconds}s`,
			summary: `${p.classification_counts["cold-ttl"]} cold turns followed a gap from the previous turn that exceeded the ${cfg.ttlSeconds}s cache TTL, so the whole prefix was rebuilt.`,
			detail: "Either keep the session warm (avoid long idle gaps mid-session) or accept the rebuild and stop paying it twice. This is behavioural — it does not indicate a structural defect.",
			evidence: `${p.classification_counts["cold-ttl"]} ttl-expiry turns across this session`,
			confidence: 0.8,
			severity: "waste",
		});
	}

	if (p.classification_counts["cold-prefix"] > 0 && coldCount > 0) {
		proposals.push({
			target_type: "config",
			title: `Prefix instability: ${p.classification_counts["cold-prefix"]} turns missed cache despite a prompt gap`,
			summary: `${p.classification_counts["cold-prefix"]} cold turns were prompt (gap within TTL) yet still missed the cache — something near the front of the context changed between turns.`,
			detail: "A mutating system preamble, a re-ordered tool schema, or an injected timestamp near the front of the context invalidates the cache prefix. This is structural; identify the mutating prefix element and make it stable.",
			evidence: `${p.classification_counts["cold-prefix"]} prefix-instability turns within the ${cfg.ttlSeconds}s TTL window`,
			confidence: 0.7,
			severity: "waste",
		});
	}

	if (p.write_churn_tokens > 0) {
		proposals.push({
			target_type: "config",
			title: `Write churn: ${p.write_churn_tokens.toLocaleString()} cache-write tokens never read`,
			summary: `This session wrote ${p.write_churn_tokens.toLocaleString()} tokens to the cache that no later turn read before the session ended — pure loss.`,
			detail: "A cache write costs more than a fresh input token and returns nothing if the prefix is never reused. Avoid write-then-abandon patterns (e.g. a large first turn that is compacted or followed by an entirely different context).",
			evidence: `${p.write_churn_tokens.toLocaleString()} write-churn tokens (${p.turns.length} billed turns total)`,
			confidence: 0.75,
			severity: "waste",
		});
	}

	return proposals;
}
