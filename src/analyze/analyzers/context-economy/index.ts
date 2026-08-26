/**
 * context-economy — a deterministic, session-level analyzer that finds where a
 * session's *input* tokens go.
 *
 * Motivation: across a real corpus, ~94% of billed tokens are `cacheRead` — the
 * accumulated context re-sent on every assistant turn — while `output` is ~0.3%.
 * A tool result is therefore not paid once: it is billed again as cacheRead on
 * *every subsequent turn* until the session ends. The true cost of a result is
 *
 *     carry_cost = result_tokens x turns_remaining_in_session   (token-turns)
 *
 * A large file read early in a long session dominates the bill even when the
 * code change is tiny. This analyzer ranks that carry cost, attributes it per
 * tool, and flags the specific offenders (oversized results, high-carry results,
 * redundant re-reads of the same file).
 *
 * Compaction-aware: a compaction event flushes context (cacheRead drops to ~0
 * and rebuilds from a summary), so a result loaded before a compaction stops
 * being billed at that boundary, not at session end. Carry is capped at the next
 * compaction after each result.
 *
 * It also tracks which skills are invoked (via the `Skill` tool) and correlates
 * skill presence with carry cost, so `/prospect-proposals` can recommend
 * skill-level improvements ("read narrower in /pr").
 *
 * All computation happens in plan() via ctx.db because MessageRow does not
 * carry the `usage` column. Results are stashed in unit.meta for analyze().
 *
 * Dollar pricing (#78): alongside token-turns, each result's carry is also
 * priced from the per-bucket billed dollars captured at sync time (#65) —
 * carryUsd re-prices the result's own tokens at every turn in its carry
 * window's implied cacheRead $/token, so a single billed total never mixes
 * input/output/cacheRead/cacheWrite into one number. Turns without a per-
 * bucket breakdown are excluded and counted, never zero-priced.
 *
 * All numbers are deterministic (no LLM). Token counts are estimated from stored
 * character lengths via `charsPerToken` (config-tunable); carry cost and turn
 * counts are exact.
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
import { Type, type Static } from "typebox";
import type { CostInfo } from "../../../types.js";

// ── emitted-node schema ──

export const CompactionCycle = Type.Object({
	/** Row ordinal of the compaction event that ends this cycle. */
	flushOrdinal: Type.Number(),
	/** Billed assistant turns in the cycle before the flush. */
	turnsSpanned: Type.Number(),
	/** Peak cacheRead across the cycle's billed turns — the carried context at flush time. */
	peakCarriedTokens: Type.Number(),
	/**
	 * Carry that an EARLIER flush (at the cycle start) would have avoided — the
	 * token-turns accrued by results loaded in this cycle before the flush.
	 * A LOWER BOUND of the saving: it only counts what moving THIS flush earlier
	 * would remove, never the future conservation beyond the cycle.
	 */
	carryAvoidedTokenTurns: Type.Number(),
	/** Context re-established after the flush (first billed turn's input + cacheWrite). */
	rebuildTokens: Type.Number(),
	firedTooLate: Type.Boolean(),
	firedTooOften: Type.Boolean(),
});
export type CompactionCycle = Static<typeof CompactionCycle>;

export const CompactionPolicy = Type.Object({
	compactionCount: Type.Number(),
	cycles: Type.Array(CompactionCycle),
	/** Sum of carryAvoidedTokenTurns across cycles (lower bound). */
	totalCarryAvoidedTokenTurns: Type.Number(),
	totalRebuildTokens: Type.Number(),
	firedTooLateCount: Type.Number(),
	firedTooOftenCount: Type.Number(),
	/** A session with substantial carry but no compaction at all. */
	neverCompacted: Type.Boolean(),
});
export type CompactionPolicy = Static<typeof CompactionPolicy>;

const ContextEconomyFlag = Type.Union([
	Type.Object({
		kind: Type.Literal("high-carry-result"),
		tool: Type.String(),
		tokens: Type.Number(),
		turnsAfter: Type.Number(),
		carryTokenTurns: Type.Number(),
		/** Carry re-priced at each carry turn's implied cacheRead dollars/token; null when no turn could be priced (#78). */
		carryUsd: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
		ordinal: Type.Number(),
	}),
	Type.Object({
		kind: Type.Literal("oversized-tool-result"),
		tool: Type.String(),
		tokens: Type.Number(),
		ordinal: Type.Number(),
	}),
	Type.Object({
		kind: Type.Literal("redundant-read"),
		path: Type.String(),
		count: Type.Number(),
	}),
]);

/** One recorded read of a path as a byte range: [start, end). `end` is `Infinity` when the limit is unknown (rest of file). */
export const ReadRange = Type.Object({
	start: Type.Number(),
	end: Type.Number(),
});
export type ReadRange = Static<typeof ReadRange>;

const ContextEconomyRawProposal = Type.Object({
	target_type: Type.String(),
	target_path: Type.Optional(Type.String()),
	title: Type.String(),
	summary: Type.String(),
	detail: Type.Optional(Type.String()),
	evidence: Type.Optional(Type.String()),
	confidence: Type.Optional(Type.Number()),
	severity: Type.String(),
});

/** The properties a context-economy metric node carries in its `contentJson`. */
export const ContextEconomyProperties = Type.Object({
	turns: Type.Number(),
	compactionCount: Type.Number(),
	billed: Type.Object({
		input: Type.Number(),
		output: Type.Number(),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
		total: Type.Number(),
	}),
	carry: Type.Object({
		totalTokenTurns: Type.Number(),
		/** Sum of per-result carryUsd, or null when no carry turn could be priced from per-bucket cost (#78). */
		totalCarryUsd: Type.Union([Type.Number(), Type.Null()]),
		/** Billed turns inside some result's carry window that contributed to a dollar figure. */
		pricedTurns: Type.Number(),
		/** Billed turns inside some carry window lacking a per-bucket breakdown — excluded, never zero-priced. */
		unpricedTurns: Type.Number(),
		byTool: Type.Record(Type.String(), Type.Number()),
	}),
	readAmplification: Type.Number(),
	flags: Type.Array(ContextEconomyFlag),
	compactionPolicy: Type.Optional(CompactionPolicy),
	topResults: Type.Array(
		Type.Object({
			tool: Type.String(),
			tokens: Type.Number(),
			turnsAfter: Type.Number(),
			carryTokenTurns: Type.Number(),
			carryUsd: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
			ordinal: Type.Number(),
		}),
	),
	skills: Type.Array(
		Type.Object({
			skill: Type.String(),
			invocationCount: Type.Number(),
			tokensLoadedAfter: Type.Number(),
			/** Stream ordinal of first use; serialised null when never re-used after loading. */
			firstOrdinal: Type.Union([Type.Number(), Type.Null()]),
		}),
	),
	improvement_proposals: Type.Array(ContextEconomyRawProposal),
});
export type ContextEconomyProperties = Static<typeof ContextEconomyProperties>;

export const CONTEXT_ECONOMY_DEF: AnalyzerDef = {
	id: "context-economy",
	label: "Context Economy",
	description:
		"Attributes a session's carried (cacheRead) tokens to the tool results that cause them, and flags oversized / high-carry / redundant reads.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: ContextEconomyProperties,
};

export const CONTEXT_ECONOMY_VERSION: AnalyzerVersion = {
	analyzerId: CONTEXT_ECONOMY_DEF.id,
	// 2.0 (issue #67): major. The recipe changes because the node now *judges*
	// compaction policy, not just accounts for it — per-cycle carry-avoided vs
	// rebuild cost, with fired-too-late and fired-too-often flags and new config
	// keys. Existing 1.2 nodes go stale/major and are revisable.
	// 2.1 (issue #156): minor. Redundant-read detection is slice-aware — reads
	// count as duplicates only when their byte ranges overlap, so paginated
	// reads of one large file no longer false-positive. Same node shape, fewer
	// redundant-read flags; existing 2.0 nodes go stale/minor and are revisable.
	// 2.2 (issue #78): minor. High-carry results are also priced in dollars —
	// carryUsd re-prices each result's own tokens at every carry turn's implied
	// cacheRead $/token from the per-bucket cost breakdown (#65), with turns
	// lacking a breakdown excluded and counted, never zero-priced. Additive
	// fields on carry/flags/topResults; existing 2.1 nodes go stale/minor.
	major: 2,
	minor: 2,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/context-economy/index.ts",
};

// ── types ──

type DbRow = {
	role: string;
	tool_calls: string | null;
	tool_results: string | null;
	usage: string | null;
};

type Flag =
	| { kind: "high-carry-result"; tool: string; tokens: number; turnsAfter: number; carryTokenTurns: number; carryUsd?: number | null; ordinal: number }
	| { kind: "oversized-tool-result"; tool: string; tokens: number; ordinal: number }
	| { kind: "redundant-read"; path: string; count: number };

type SkillEvent = {
	skill: string;
	ordinal: number;
	args?: string;
};

type SkillStats = {
	invocationCount: number;
	tokensLoadedAfter: number;
	firstOrdinal: number;
};

type RawProposal = Static<typeof ContextEconomyRawProposal>;

// ── config ──

export interface ContextEconomyConfig {
	charsPerToken: number;
	oversizedResultTokens: number;
	highCarryTokenTurns: number;
	topResultsCount: number;
	/** Compaction policy (issue #67): a cycle that spanned this many billed turns and could have saved this much carry is judged fired-too-late. */
	firedTooLateTurnsMin: number;
	firedTooLateCarryTokenTurns: number;
	/** A cycle whose rebuild cost crosses this, while it carried no more than its rebuild, is judged fired-too-often. */
	firedTooOftenRebuildTokens: number;
}

export const DEFAULT_CONTEXT_ECONOMY_CONFIG: ContextEconomyConfig = {
	charsPerToken: 3.5,
	/** ~P93 of result sizes in the corpus (P90=1,065, P95=2,147). */
	oversizedResultTokens: 4000,
	/** ~P90 of per-result carry in the corpus. */
	highCarryTokenTurns: 1_000_000,
	topResultsCount: 8,
	/** At least this many turns spanned before a flush counts as late. */
	firedTooLateTurnsMin: 5,
	/** An earlier flush that would have avoided at least this many token-turns counts as late. */
	firedTooLateCarryTokenTurns: 1_000_000,
	/** Rebuild cost above this is expensive enough to be a candidate fired-too-often. */
	firedTooOftenRebuildTokens: 50_000,
};

// ── slice-aware redundant-read counting (issue #156) ──

/**
 * Coerce a tool-call argument into a finite non-negative number, or null when
 * it is absent / not numeric.
 */
function nonNegNumberArg(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
	if (typeof v === "string" && v.trim() !== "") {
		const n = Number(v);
		if (Number.isFinite(n) && n >= 0) return n;
	}
	return null;
}

/**
 * Build a read's byte range from its call arguments. A missing offset is 0;
 * a missing (or unknown) limit means "rest of file", i.e. an unbounded range.
 * A whole-file read is therefore [0, ∞) and overlaps every other read of the
 * same path, while two disjoint slices never overlap.
 */
export function readRangeFromArgs(args: Record<string, unknown> | undefined): ReadRange {
	const offset = nonNegNumberArg(args?.["offset"]) ?? 0;
	const limit = nonNegNumberArg(args?.["limit"]);
	return { start: offset, end: limit === null ? Infinity : offset + limit };
}

/** Two read ranges overlap iff their half-open intervals intersect. */
export function readRangesOverlap(a: ReadRange, b: ReadRange): boolean {
	return Math.max(a.start, b.start) < Math.min(a.end, b.end);
}

/**
 * Count how many of a path's reads re-read content some earlier read already
 * loaded: a read counts when its range overlaps ANY other read of that path.
 * Paginating a large file (disjoint slices) yields 0; genuinely re-reading an
 * overlapping region — including whole-file reads before or after slices —
 * makes both participants of the overlap count.
 */
export function countRedundantReads(ranges: ReadRange[]): number {
	let count = 0;
	for (let i = 0; i < ranges.length; i++) {
		const r = ranges[i]!;
		if (ranges.some((other, j) => j !== i && readRangesOverlap(r, other))) count++;
	}
	return count;
}

// ── threshold defaults for analyze() (plan already used config values) ──

const OVERSIZED_TOKENS = 4000;
const SKILL_TOKENS_AFTER_THRESHOLD = 50000;
const SESSION_CARRY_THRESHOLD = 5_000_000;

// ── compaction policy computation (issue #67) ──

function parseUsage(row: DbRow): Record<string, number> | null {
	if (!row.usage) return null;
	try {
		return JSON.parse(row.usage) as Record<string, number>;
	} catch {
		return null;
	}
}

// ── carry pricing in dollars (issue #78) ──

/** Per-turn billing inputs a carry window is priced from. */
export interface CarryTurnBilling {
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Per-bucket billed dollars, or null when the host reported none. */
	cost: Pick<CostInfo, "input" | "output" | "cacheRead" | "cacheWrite"> | null;
}

export interface CarryPricing {
	/** Dollars billed for re-reading this result across its priced turns, or null when no turn could be priced. */
	carryUsd: number | null;
	pricedTurns: number;
	unpricedTurns: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Parse one assistant turn's stored usage JSON into the billing inputs the
 * carry pricing reads. The per-bucket cost breakdown lives inside the usage
 * blob next to the token buckets (#65); its absence means the host reported
 * none for this turn — UNKNOWN cost, never zero cost.
 */
export function parseCarryBilling(row: DbRow): CarryTurnBilling | null {
	if (row.role !== "assistant" || !row.usage) return null;
	const u = parseUsage(row);
	if (!u) return null;
	const costObj = u["cost"] as Record<string, unknown> | null | undefined;
	return {
		inputTokens: num(u["input"]),
		cacheReadTokens: num(u["cacheRead"]),
		cacheWriteTokens: num(u["cacheWrite"]),
		cost:
			costObj && typeof costObj === "object"
				? {
						input: num(costObj["input"]),
						output: num(costObj["output"]),
						cacheRead: num(costObj["cacheRead"]),
						cacheWrite: num(costObj["cacheWrite"]),
					}
				: null,
	};
}

/** Round dollars to six decimals, matching the tool-inventory-tax precedent. */
function roundUsd(usd: number): number {
	return Math.round(usd * 1e6) / 1e6;
}

/**
 * Whether one turn carries enough information to price dollars at all: it must
 * report a per-bucket breakdown AND a token denominator the prefix was paid
 * under (cacheRead on a carry turn; input + cacheWrite on a rebuild turn).
 */
export function isPricedTurn(t: CarryTurnBilling): boolean {
	if (!t.cost) return false;
	return t.cacheReadTokens > 0 || t.inputTokens + t.cacheWriteTokens > 0;
}

/**
 * One turn's implied prefix price per token: cacheRead $/token when the cache
 * was read, blended (input + cacheWrite) $/token when it was rebuilt mid-window.
 * Null when the turn is unpriced (no breakdown or no denominator).
 */
export function turnImpliedRate(t: CarryTurnBilling): number | null {
	if (t.cacheReadTokens > 0 && t.cost) return t.cost.cacheRead / t.cacheReadTokens;
	const denom = t.inputTokens + t.cacheWriteTokens;
	if (denom > 0 && t.cost) return (t.cost.input + t.cost.cacheWrite) / denom;
	return null;
}

/**
 * Price one result's carry in dollars across its carry window (issue #78).
 *
 * A carried result rides in the request prefix of every subsequent billed
 * turn, so each turn prices the result's own tokens at that turn's implied
 * rate from its per-bucket dollars — cacheRead $/token on a carry turn, or
 * blended (input + cacheWrite) $/token when a rebuild turn lost the cache
 * mid-window and the prefix was paid there instead. This mirrors the
 * tool-inventory-tax pricing method; it attributes to each result only its
 * own share of a turn's dollars rather than the whole bill.
 *
 * A turn without a per-bucket cost breakdown contributes nothing and is
 * counted as unpriced — never zero-priced. When nothing can be priced,
 * carryUsd is null.
 */
export function priceCarry(resultTokens: number, turns: ReadonlyArray<CarryTurnBilling>): CarryPricing {
	let total = 0;
	let pricedTurns = 0;
	let unpricedTurns = 0;
	for (const t of turns) {
		const rate = turnImpliedRate(t);
		if (rate === null) {
			unpricedTurns++;
		} else {
			total += resultTokens * rate;
			pricedTurns++;
		}
	}
	return { carryUsd: pricedTurns > 0 ? roundUsd(total) : null, pricedTurns, unpricedTurns };
}

/**
 * Judge the session's compaction policy. Each cycle runs from just after the
 * previous compaction (or session start) to the next compaction event. For a
 * cycle we measure what an EARLIER flush (at the cycle start) would have
 * avoided — the carry accrued by results loaded in the cycle — versus the cost
 * of re-establishing context after the actual flush. All token figures inherit
 * the `charsPerToken` estimate; the carry-avoided number is a LOWER BOUND.
 */
export function analyzeCompactionPolicy(
	rows: DbRow[],
	results: Array<{ ordinal: number; carry: number }>,
	cfg: ContextEconomyConfig,
	charsPerToken: number,
): CompactionPolicy {
	const n = rows.length;
	const billedPrefix = new Array(n + 1).fill(0);
	for (let i = 0; i < n; i++) {
		const isBilled = rows[i]!.role === "assistant" && rows[i]!.usage ? 1 : 0;
		billedPrefix[i + 1] = billedPrefix[i] + isBilled;
	}

	// usage per billed turn (for cacheRead + rebuild) keyed by row ordinal.
	const usageCacheRead = new Map<number, number>();
	const usageRebuild = new Map<number, number>(); // input + cacheWrite
	for (let i = 0; i < n; i++) {
		const u = parseUsage(rows[i]!);
		if (!u) continue;
		usageCacheRead.set(i, u["cacheRead"] ?? 0);
		usageRebuild.set(i, (u["input"] ?? 0) + (u["cacheWrite"] ?? 0));
	}

	const compactions: number[] = [];
	for (let i = 0; i < n; i++) if (rows[i]!.role === "compaction") compactions.push(i);

	const cycles: CompactionCycle[] = [];
	for (let ci = 0; ci < compactions.length; ci++) {
		const flush = compactions[ci]!;
		const prev = ci > 0 ? compactions[ci - 1]! : -1;

		// Billed turns strictly inside the cycle: (prev, flush].
		let turnsSpanned = billedPrefix[flush + 1]! - billedPrefix[prev + 1]!;
		if (turnsSpanned < 0) turnsSpanned = 0;

		let peakCarried = 0;
		for (let i = prev + 1; i <= flush; i++) {
			const cr = usageCacheRead.get(i);
			if (cr !== undefined && cr > peakCarried) peakCarried = cr;
		}

		// Carry avoided by an earlier flush at the cycle start == the carry of
		// results loaded in this cycle (each result's carry is already capped at
		// this flush by the existing carry model).
		let carryAvoided = 0;
		for (const r of results) {
			if (r.ordinal > prev && r.ordinal < flush) carryAvoided += r.carry;
		}

		// Rebuild cost: the first billed turn after the flush re-establishes the
		// prefix (input + cacheWrite).
		let rebuildTokens = 0;
		for (let i = flush + 1; i < n; i++) {
			const rb = usageRebuild.get(i);
			if (rb !== undefined) {
				rebuildTokens = rb;
				break;
			}
		}

		const firedTooLate = turnsSpanned >= cfg.firedTooLateTurnsMin && carryAvoided >= cfg.firedTooLateCarryTokenTurns;
		const firedTooOften = rebuildTokens >= cfg.firedTooOftenRebuildTokens && peakCarried <= rebuildTokens;

		cycles.push({
			flushOrdinal: flush,
			turnsSpanned,
			peakCarriedTokens: Math.round(peakCarried),
			carryAvoidedTokenTurns: Math.round(carryAvoided),
			rebuildTokens: Math.round(rebuildTokens),
			firedTooLate,
			firedTooOften,
		});
	}

	const totalCarryAvoidedTokenTurns = cycles.reduce((a, c) => a + c.carryAvoidedTokenTurns, 0);
	const totalRebuildTokens = cycles.reduce((a, c) => a + c.rebuildTokens, 0);
	const firedTooLateCount = cycles.filter((c) => c.firedTooLate).length;
	const firedTooOftenCount = cycles.filter((c) => c.firedTooOften).length;

	// A session that never compacted but carried a lot is a fired-too-late at
	// session scale. totalCarryApprox is the sum of carry over ALL results.
	const totalCarry = results.reduce((a, r) => a + r.carry, 0);

	return {
		compactionCount: compactions.length,
		cycles,
		totalCarryAvoidedTokenTurns,
		totalRebuildTokens,
		firedTooLateCount,
		firedTooOftenCount,
		neverCompacted: compactions.length === 0 && totalCarry >= SESSION_CARRY_THRESHOLD,
	};
}

// ── analyzer ──

export const contextEconomyAnalyzer: Analyzer = {
	def: CONTEXT_ECONOMY_DEF,
	version: CONTEXT_ECONOMY_VERSION,
	prompts: {},
	defaultConfig: {
		id: "",
		analyzerId: CONTEXT_ECONOMY_DEF.id,
		configHash: computeConfigHash(DEFAULT_CONTEXT_ECONOMY_CONFIG),
		configJson: DEFAULT_CONTEXT_ECONOMY_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		if (ctx.messages.length === 0) return [];

		const cfg = ctx.config as unknown as ContextEconomyConfig;
		const charsPerToken = cfg.charsPerToken ?? DEFAULT_CONTEXT_ECONOMY_CONFIG.charsPerToken;
		const oversizedResultTokens = cfg.oversizedResultTokens ?? DEFAULT_CONTEXT_ECONOMY_CONFIG.oversizedResultTokens;
		const highCarryTokenTurns = cfg.highCarryTokenTurns ?? DEFAULT_CONTEXT_ECONOMY_CONFIG.highCarryTokenTurns;
		const topResultsCount = cfg.topResultsCount ?? DEFAULT_CONTEXT_ECONOMY_CONFIG.topResultsCount;
		const firedTooLateTurnsMin = cfg.firedTooLateTurnsMin ?? DEFAULT_CONTEXT_ECONOMY_CONFIG.firedTooLateTurnsMin;
		const firedTooLateCarryTokenTurns = cfg.firedTooLateCarryTokenTurns ?? DEFAULT_CONTEXT_ECONOMY_CONFIG.firedTooLateCarryTokenTurns;
		const firedTooOftenRebuildTokens = cfg.firedTooOftenRebuildTokens ?? DEFAULT_CONTEXT_ECONOMY_CONFIG.firedTooOftenRebuildTokens;

		const rows = (await ctx.db
			.prepare("SELECT role, tool_calls, tool_results, usage FROM messages WHERE session_id = ? ORDER BY rowid ASC")
			.all(ctx.sessionId)) as DbRow[];

		const n = rows.length;
		// A compaction event flushes context: cacheRead drops to ~0 and rebuilds from
		// a summary. So a tool result loaded before a compaction stops being billed at
		// that boundary, not at session end. We cap each result's carry at the next
		// compaction after it.
		//   billedPrefix[k]      = billed assistant turns in rows[0..k-1]
		//   nextCompaction[k]    = smallest ordinal >= k that is a compaction event (else n)
		//   turnsAfter(i)        = billedPrefix[nextCompaction[i+1]] - billedPrefix[i+1]
		const billedPrefix = new Array(n + 1).fill(0);
		for (let i = 0; i < n; i++) {
			const isBilled = rows[i]!.role === "assistant" && rows[i]!.usage ? 1 : 0;
			billedPrefix[i + 1] = billedPrefix[i] + isBilled;
		}
		const nextCompaction = new Array(n + 1).fill(n);
		let nc = n;
		for (let i = n - 1; i >= 0; i--) {
			if (rows[i]!.role === "compaction") nc = i;
			nextCompaction[i] = nc;
		}
		let compactionCount = 0;
		for (let i = 0; i < n; i++) if (rows[i]!.role === "compaction") compactionCount++;

		// Per-turn billing inputs keyed by row ordinal, so each result's carry can
		// be re-priced in dollars at its window turns' own implied rates (#78).
		const billingByOrdinal = new Map<number, CarryTurnBilling>();
		for (let i = 0; i < n; i++) {
			const b = parseCarryBilling(rows[i]!);
			if (b) billingByOrdinal.set(i, b);
		}
		// Distinct billed turns inside some result's carry window, classified once
		// per turn (a turn can sit in several windows) for honest coverage counts.
		const pricedOrdinals = new Set<number>();
		const unpricedOrdinals = new Set<number>();

		const billed = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		let turns = 0;
		const carryByTool: Record<string, number> = {};
		const results: Array<{ tool: string; tokens: number; turnsAfter: number; carry: number; ordinal: number }> = [];
		/** Dollar carry (#78) per result ordinal: null when no window turn could be priced. */
		const carryUsdByOrdinal = new Map<number, number | null>();
		// Slice-aware read tracking (issue #156): reads are recorded as byte ranges
	// per path, so paginated reads of one large file (disjoint slices) are not
	// flagged as redundant — only genuinely overlapping content reads are.
	const readPathRanges: Record<string, ReadRange[]> = {};
		const skillEvents: SkillEvent[] = [];

		for (let i = 0; i < n; i++) {
			const r = rows[i]!;
			if (r.role === "assistant" && r.usage) {
				try {
					const u = JSON.parse(r.usage) as Record<string, number>;
					turns++;
					billed.input += u["input"] ?? 0;
					billed.output += u["output"] ?? 0;
					billed.cacheRead += u["cacheRead"] ?? 0;
					billed.cacheWrite += u["cacheWrite"] ?? 0;
					billed.total += u["totalTokens"] ?? 0;
				} catch {
					/* ignore malformed usage */
				}
			}
			if (r.tool_calls) {
				try {
					const calls = JSON.parse(r.tool_calls) as Array<{ name?: string; arguments?: Record<string, unknown> }>;
					for (const c of calls) {
						if (c.name === "read") {
							const p = c.arguments?.["path"];
							if (typeof p === "string") {
								(readPathRanges[p] ??= []).push(readRangeFromArgs(c.arguments));
							}
						}
						if (c.name === "Skill") {
							const skillName = c.arguments?.["skill"];
							if (typeof skillName === "string") {
								skillEvents.push({
									skill: skillName,
									ordinal: i,
									args: typeof c.arguments?.["args"] === "string" ? (c.arguments["args"] as string) : undefined,
								});
							}
						}
					}
				} catch {
					/* ignore */
				}
			}
			if (r.role === "toolResult" && r.tool_results) {
				try {
					const trs = JSON.parse(r.tool_results) as Array<{ toolName?: string; textLength?: number }>;
					const textLen = trs.reduce((a, t) => a + (Number(t.textLength) || 0), 0);
					const tool = (trs[0]?.toolName || "unknown").trim() || "unknown";
					const tokens = textLen / charsPerToken;
					const turnsAfter = billedPrefix[nextCompaction[i + 1]!]! - billedPrefix[i + 1]!;
					const carry = tokens * turnsAfter;
					carryByTool[tool] = (carryByTool[tool] ?? 0) + carry;
				// Dollar carry (#78): this result's own tokens × each carry turn's implied rate.
				const windowEnd = nextCompaction[i + 1]!;
				const windowTurns: CarryTurnBilling[] = [];
				for (let j = i + 1; j < windowEnd; j++) {
					const b = billingByOrdinal.get(j);
					if (!b) continue;
					windowTurns.push(b);
					(isPricedTurn(b) ? pricedOrdinals : unpricedOrdinals).add(j);
				}
				carryUsdByOrdinal.set(i, priceCarry(tokens, windowTurns).carryUsd);
					results.push({ tool, tokens, turnsAfter, carry, ordinal: i });
				} catch {
					/* ignore */
				}
			}
		}

		results.sort((a, b) => b.carry - a.carry);

		const flags: Flag[] = [];
		for (const res of results) {
			if (res.carry >= highCarryTokenTurns) {
				flags.push({
					kind: "high-carry-result",
					tool: res.tool,
					tokens: Math.round(res.tokens),
					turnsAfter: res.turnsAfter,
					carryTokenTurns: Math.round(res.carry),
					carryUsd: carryUsdByOrdinal.get(res.ordinal) ?? null,
					ordinal: res.ordinal,
				});
			}
			if (res.tokens >= oversizedResultTokens) {
				flags.push({ kind: "oversized-tool-result", tool: res.tool, tokens: Math.round(res.tokens), ordinal: res.ordinal });
			}
		}
		for (const [path, ranges] of Object.entries(readPathRanges)) {
			const count = countRedundantReads(ranges);
			if (count >= 2) flags.push({ kind: "redundant-read", path, count });
		}

		const totalCarry = results.reduce((a, r) => a + r.carry, 0);
		const perResultCarryUsd = results
			.map((r) => carryUsdByOrdinal.get(r.ordinal))
			.filter((v): v is number => typeof v === "number");
		// null when no result's window had a priced turn — never a silent zero.
		const totalCarryUsd = perResultCarryUsd.length > 0 ? roundUsd(perResultCarryUsd.reduce((a, v) => a + v, 0)) : null;
		const readBashCarry = (carryByTool["read"] ?? 0) + (carryByTool["bash"] ?? 0);
		const readAmplification = billed.output > 0 ? readBashCarry / billed.output : 0;

		const skillStats: Record<string, SkillStats> = {};
		for (const se of skillEvents) {
			const ss = (skillStats[se.skill] ??= { invocationCount: 0, tokensLoadedAfter: 0, firstOrdinal: Infinity });
			ss.invocationCount++;
			if (se.ordinal < ss.firstOrdinal) ss.firstOrdinal = se.ordinal;
		}
		for (const res of results) {
			for (const ss of Object.values(skillStats)) {
				if (res.ordinal > ss.firstOrdinal) {
					ss.tokensLoadedAfter += Math.round(res.tokens);
				}
			}
		}

		const meta = {
			result: {
				turns,
				compactionCount,
				billed,
				carry: {
					totalTokenTurns: Math.round(totalCarry),
					totalCarryUsd,
					pricedTurns: pricedOrdinals.size,
					unpricedTurns: unpricedOrdinals.size,
					byTool: Object.fromEntries(Object.entries(carryByTool).map(([k, v]) => [k, Math.round(v)])),
				},
				readAmplification: Math.round(readAmplification),
				flags,
				compactionPolicy: analyzeCompactionPolicy(
					rows,
					results,
					{ firedTooLateTurnsMin, firedTooLateCarryTokenTurns, firedTooOftenRebuildTokens } as ContextEconomyConfig,
					charsPerToken,
				),
				topResults: results.slice(0, topResultsCount).map((r) => ({
					tool: r.tool,
					tokens: Math.round(r.tokens),
					turnsAfter: r.turnsAfter,
					carryTokenTurns: Math.round(r.carry),
					carryUsd: carryUsdByOrdinal.get(r.ordinal) ?? null,
					ordinal: r.ordinal,
				})),
				skills: Object.entries(skillStats)
					.sort((a, b) => b[1].tokensLoadedAfter - a[1].tokensLoadedAfter)
					.map(([name, ss]) => ({
						skill: name,
						invocationCount: ss.invocationCount,
						tokensLoadedAfter: ss.tokensLoadedAfter,
						firstOrdinal: ss.firstOrdinal,
					})),
			},
		};

		const sources: SourceRef[] = [{ kind: "session", id: ctx.sessionId }];

		return [
			{
				sources,
				sourceSetHash: `context-economy:${ctx.sessionId}`,
				anchorKind: "session",
				anchorRef: ctx.sessionId,
				meta,
			},
		];
	},

	analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): AnalysisResult {
		const result = (unit.meta?.["result"] as Record<string, unknown>) ?? {};
		const flags = (result["flags"] as Flag[]) ?? [];
		const skills = (result["skills"] as Array<Record<string, unknown>>) ?? [];
		const billed = (result["billed"] as Record<string, number>) ?? {};
		const carry = (result["carry"] as Record<string, unknown>) ?? {};
		const readAmpl = result["readAmplification"] as number;
		const compactionPolicy = result["compactionPolicy"] as CompactionPolicy | undefined;

		const proposals: RawProposal[] = [];

		// ── deterministic proposals from flags ──
		const mergedCarry: Record<string, { tool: string; tokens: number; turnsAfter?: number; carryTokenTurns?: number; carryUsd?: number | null }> = {};
		const mergedRedundant: Set<string> = new Set();

		for (const f of flags) {
			if (f.kind === "oversized-tool-result") {
				const key = `result:${f.ordinal}`;
				const e = (mergedCarry[key] ??= { tool: f.tool, tokens: f.tokens });
				e.tokens = Math.max(e.tokens, f.tokens);
			}
			if (f.kind === "high-carry-result") {
				const key = `result:${f.ordinal}`;
				const e = (mergedCarry[key] ??= { tool: f.tool, tokens: f.tokens });
				e.turnsAfter = f.turnsAfter;
				e.carryTokenTurns = f.carryTokenTurns;
				e.carryUsd = f.carryUsd;
			}
			if (f.kind === "redundant-read") {
				mergedRedundant.add(f.path);
			}
		}

		for (const [key, info] of Object.entries(mergedCarry)) {
			const ordinal = parseInt(key.split(":")[1]!);
			// Dollar figure (#78) rides beside the token-turn number wherever it
			// appears — token-turns explain why a small read is expensive; dollars
			// say what that cost. Null/unpriced carries no figure at all.
			const usd = info.carryUsd != null ? ` ($${info.carryUsd.toFixed(4)})` : "";
			const cc = info.carryTokenTurns
				? `${info.carryTokenTurns.toLocaleString()} token-turns (${info.tokens} tok × ${info.turnsAfter} turns)${usd}`
				: `${info.tokens} tokens`;
			proposals.push({
				target_type: "prompt",
				title: `${info.tool} result at ordinal ${ordinal}: ${cc}`,
				summary: `A ${info.tool} result at message ordinal ${ordinal} carried ${cc}${info.carryTokenTurns ? " total" : ""}. This result is re-billed as cacheRead on every subsequent assistant turn.`,
				detail: info.carryTokenTurns
					? `Move this read later in the session (closer to where it's actually used), or split long sessions so large reads don't trail through hundreds of irrelevant turns.${info.carryUsd != null ? ` The carry was billed about $${info.carryUsd.toFixed(4)} as cacheRead.` : ""}`
					: "Oversized tool results are re-billed as cacheRead on every subsequent turn. Consider reading only the specific sections needed, or using grep/search instead of full-file reads for large files.",
				evidence: `${info.tool} at ordinal ${ordinal}: ${info.tokens} tok${info.turnsAfter ? ` × ${info.turnsAfter} turns = ${info.carryTokenTurns?.toLocaleString()} token-turns${usd}` : ""}${info.carryUsd == null && info.carryTokenTurns ? "; no per-bucket cost recorded to price dollars" : ""}`,
				confidence: 0.85,
				severity: "waste",
			});
		}

		for (const ff of flags) {
			if (ff.kind !== "redundant-read") continue;
			if (!mergedRedundant.has(ff.path)) continue;
			mergedRedundant.delete(ff.path);
			proposals.push({
				target_type: "prompt",
				title: `Eliminate redundant read: ${ff.path} read ${ff.count} times`,
				summary: `The file ${ff.path} was read ${ff.count} times in this session.`,
				detail: "Re-reading files already in context wastes input tokens — each re-read re-sends the full content via cacheRead. Keep a note of what was already read, or use a search/grep to find specific sections instead of re-reading the whole file.",
				evidence: `${ff.path} read ${ff.count} times`,
				confidence: 0.8,
				severity: "waste",
			});
		}

		for (const s of skills) {
			const tokensAfter = s["tokensLoadedAfter"] as number;
			const invocations = s["invocationCount"] as number;
			if (tokensAfter > SKILL_TOKENS_AFTER_THRESHOLD && invocations >= 1) {
				proposals.push({
					target_type: "skill",
					target_path: s["skill"] as string,
					title: `Skill "${s["skill"] as string}" loaded ${tokensAfter.toLocaleString()} tokens after first use`,
					summary: `Skill "${s["skill"] as string}" was invoked ${invocations} time(s). After it first ran, ${tokensAfter.toLocaleString()} tokens were loaded as tool results that trailed through later turns.`,
					detail: "Consider narrowing the tool calls this skill makes — read only necessary sections, limit bash output, or use grep/search instead of full file reads. For multi-step skills, break work into shorter sessions to reduce carry.",
					evidence: `Skill ${s["skill"] as string}: first at ordinal ${s["firstOrdinal"] as number}, ${tokensAfter.toLocaleString()} tokens of tool results loaded afterward across ${invocations} invocation(s)`,
					confidence: 0.7,
					severity: "waste",
				});
			}
		}

		// ── compaction policy (issue #67) ──
		if (compactionPolicy) {
			if (compactionPolicy.firedTooLateCount > 0) {
				const cycles = compactionPolicy.cycles.filter((c) => c.firedTooLate);
				const avoided = cycles.reduce((a, c) => a + c.carryAvoidedTokenTurns, 0);
				proposals.push({
					target_type: "config",
					title: `Compaction fired too late: ${cycles.length} flush(es) could have saved ${avoided.toLocaleString()} token-turns`,
					summary: `${cycles.length} compaction(s) ran ${cycles.map((c) => c.turnsSpanned).join(", ")} turns after the context grew; an earlier flush at each cycle start would have avoided ${avoided.toLocaleString()} token-turns of carry (LOWER BOUND).`,
					detail: "Each turn before a late flush paid to carry context that an earlier flush would have dropped. Consider lowering the compaction threshold so it fires sooner (this is a one-time harness-config change that pays out every future session).",
					evidence: `total carry avoided (lower bound) ${compactionPolicy.totalCarryAvoidedTokenTurns.toLocaleString()} token-turns across ${compactionPolicy.cycles.length} cycle(s); ${compactionPolicy.firedTooLateCount} fired-too-late.`,
					confidence: 0.7,
					severity: "waste",
				});
			}
			if (compactionPolicy.firedTooOftenCount > 0) {
				const cycles = compactionPolicy.cycles.filter((c) => c.firedTooOften);
				const rebuild = cycles.reduce((a, c) => a + c.rebuildTokens, 0);
				proposals.push({
					target_type: "config",
					title: `Compaction fired too often: ${cycles.length} flush(es) rebuilt more context than they carried`,
					summary: `${cycles.length} compaction(s) cost ${rebuild.toLocaleString()} tokens to rebuild the cache prefix while carrying ${cycles[0]?.peakCarriedTokens.toLocaleString() ?? "0"} tokens or less — pure loss.`,
					detail: "Each compaction pays to summarise and then re-establish the cache prefix from scratch. Beyond a cadence the rebuild costs more than the carry it saves. Consider raising the compaction threshold or compressing less frequently.",
					evidence: `total rebuild ${compactionPolicy.totalRebuildTokens.toLocaleString()} tokens across ${compactionPolicy.cycles.length} cycle(s); ${compactionPolicy.firedTooOftenCount} fired-too-often.`,
					confidence: 0.7,
					severity: "waste",
				});
			}
			if (compactionPolicy.compactionCount === 0 && compactionPolicy.neverCompacted) {
				const totalTT = ((carry["totalTokenTurns"] as number) ?? 0).toLocaleString();
				const totalUsd = carry["totalCarryUsd"];
				const usdNote = totalUsd != null ? ` ($${(totalUsd as number).toFixed(4)} billed as cacheRead)` : "";
				proposals.push({
					target_type: "config",
					title: `Session never compacted despite ${totalTT} token-turns of carry${usdNote}`,
					summary: `This session carried substantial context to its end without ever compacting, so every result stayed billed as cacheRead until the last turn.${usdNote}`,
					detail: "Consider compacting long sessions so early large reads do not trail through the whole conversation, or split the work into shorter sessions.",
					evidence: `${totalTT} token-turns carried${usdNote}; 0 compactions.`,
					confidence: 0.6,
					severity: "suggestion",
				});
			}
		}

		const totalCarry = (carry["totalTokenTurns"] as number) ?? 0;
		if (totalCarry > SESSION_CARRY_THRESHOLD && billed["output"] && billed["output"] > 0) {
			const totalUsd = carry["totalCarryUsd"];
			const usd = totalUsd != null ? ` ($${(totalUsd as number).toFixed(4)})` : "";
			proposals.push({
				target_type: "general",
				title: `High carry-cost session: ${totalCarry.toLocaleString()} token-turns${usd}, read amplification ${readAmpl}×`,
				summary: `This session spent ${totalCarry.toLocaleString()} token-turns on carried context (read amplification ${readAmpl}× output)${usd}.`,
				detail: "Session is dominated by carried context rather than output. Consider breaking long coding sessions into shorter focused ones, using search/grep instead of full reads, and avoiding redundant reads.",
				evidence: `${totalCarry.toLocaleString()} total carry token-turns${usd}; ${(billed["cacheRead"] ?? 0).toLocaleString()} cacheRead tokens; read amplification ${readAmpl}×`,
				confidence: 0.6,
				severity: "suggestion",
			});
		}

		return {
			nodeKind: proposals.length > 0 ? "proposal" : "metric",
			contentJson: { ...result, improvement_proposals: proposals },
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			edges: [
				{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
			],
		};
	},
};