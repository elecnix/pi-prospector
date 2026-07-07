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
 * It also tracks which skills are invoked (via the `Skill` tool) and correlates
 * skill presence with carry cost, so `/prospect-proposals` can recommend
 * skill-level improvements ("read narrower in /pr").
 *
 * All computation happens in plan() via ctx.db because MessageRow does not
 * carry the `usage` column. Results are stashed in unit.meta for analyze().
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

export const CONTEXT_ECONOMY_DEF: AnalyzerDef = {
	id: "context-economy",
	label: "Context Economy",
	description:
		"Attributes a session's carried (cacheRead) tokens to the tool results that cause them, and flags oversized / high-carry / redundant reads.",
	anchorSpan: "full_session",
	dependencies: [],
};

export const CONTEXT_ECONOMY_VERSION: AnalyzerVersion = {
	analyzerId: CONTEXT_ECONOMY_DEF.id,
	major: 1,
	minor: 1,
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
	| { kind: "high-carry-result"; tool: string; tokens: number; turnsAfter: number; carryTokenTurns: number; ordinal: number }
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

interface RawProposal {
	target_type: string;
	target_path?: string;
	title: string;
	summary: string;
	detail?: string;
	evidence?: string;
	confidence?: number;
	severity: string;
}

// ── config ──

export interface ContextEconomyConfig {
	charsPerToken: number;
	oversizedResultTokens: number;
	highCarryTokenTurns: number;
	topResultsCount: number;
}

export const DEFAULT_CONTEXT_ECONOMY_CONFIG: ContextEconomyConfig = {
	charsPerToken: 3.5,
	/** ~P93 of result sizes in the corpus (P90=1,065, P95=2,147). */
	oversizedResultTokens: 4000,
	/** ~P90 of per-result carry in the corpus. */
	highCarryTokenTurns: 1_000_000,
	topResultsCount: 8,
};

// ── threshold defaults for analyze() (plan already used config values) ──

const OVERSIZED_TOKENS = 4000;
const SKILL_TOKENS_AFTER_THRESHOLD = 50000;
const SESSION_CARRY_THRESHOLD = 5_000_000;

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

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		if (ctx.messages.length === 0) return [];

		const cfg = ctx.config as unknown as ContextEconomyConfig;
		const charsPerToken = cfg.charsPerToken ?? DEFAULT_CONTEXT_ECONOMY_CONFIG.charsPerToken;
		const oversizedResultTokens = cfg.oversizedResultTokens ?? DEFAULT_CONTEXT_ECONOMY_CONFIG.oversizedResultTokens;
		const highCarryTokenTurns = cfg.highCarryTokenTurns ?? DEFAULT_CONTEXT_ECONOMY_CONFIG.highCarryTokenTurns;
		const topResultsCount = cfg.topResultsCount ?? DEFAULT_CONTEXT_ECONOMY_CONFIG.topResultsCount;

		const rows = ctx.db
			.prepare("SELECT role, tool_calls, tool_results, usage FROM messages WHERE session_id = ? ORDER BY rowid ASC")
			.all(ctx.sessionId) as DbRow[];

		const n = rows.length;
		const suffix = new Array(n + 1).fill(0);
		for (let i = n - 1; i >= 0; i--) {
			const billed = rows[i]!.role === "assistant" && rows[i]!.usage ? 1 : 0;
			suffix[i] = suffix[i + 1] + billed;
		}

		const billed = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		let turns = 0;
		const carryByTool: Record<string, number> = {};
		const results: Array<{ tool: string; tokens: number; turnsAfter: number; carry: number; ordinal: number }> = [];
		const readPathCounts: Record<string, number> = {};
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
							if (typeof p === "string") readPathCounts[p] = (readPathCounts[p] ?? 0) + 1;
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
					const turnsAfter = suffix[i + 1]!;
					const carry = tokens * turnsAfter;
					carryByTool[tool] = (carryByTool[tool] ?? 0) + carry;
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
					ordinal: res.ordinal,
				});
			}
			if (res.tokens >= oversizedResultTokens) {
				flags.push({ kind: "oversized-tool-result", tool: res.tool, tokens: Math.round(res.tokens), ordinal: res.ordinal });
			}
		}
		for (const [path, count] of Object.entries(readPathCounts)) {
			if (count >= 2) flags.push({ kind: "redundant-read", path, count });
		}

		const totalCarry = results.reduce((a, r) => a + r.carry, 0);
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
				billed,
				carry: {
					totalTokenTurns: Math.round(totalCarry),
					byTool: Object.fromEntries(Object.entries(carryByTool).map(([k, v]) => [k, Math.round(v)])),
				},
				readAmplification: Math.round(readAmplification),
				flags,
				topResults: results.slice(0, topResultsCount).map((r) => ({
					tool: r.tool,
					tokens: Math.round(r.tokens),
					turnsAfter: r.turnsAfter,
					carryTokenTurns: Math.round(r.carry),
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

		const proposals: RawProposal[] = [];

		// ── deterministic proposals from flags ──
		const mergedCarry: Record<string, { tool: string; tokens: number; turnsAfter?: number; carryTokenTurns?: number }> = {};
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
			}
			if (f.kind === "redundant-read") {
				mergedRedundant.add(f.path);
			}
		}

		for (const [key, info] of Object.entries(mergedCarry)) {
			const ordinal = parseInt(key.split(":")[1]!);
			const cc = info.carryTokenTurns
				? `${info.carryTokenTurns.toLocaleString()} token-turns (${info.tokens} tok × ${info.turnsAfter} turns)`
				: `${info.tokens} tokens`;
			proposals.push({
				target_type: "prompt",
				title: `${info.tool} result at ordinal ${ordinal}: ${cc}`,
				summary: `A ${info.tool} result at message ordinal ${ordinal} carried ${cc}${info.carryTokenTurns ? " total" : ""}. This result is re-billed as cacheRead on every subsequent assistant turn.`,
				detail: info.carryTokenTurns
					? "Move this read later in the session (closer to where it's actually used), or split long sessions so large reads don't trail through hundreds of irrelevant turns."
					: "Oversized tool results are re-billed as cacheRead on every subsequent turn. Consider reading only the specific sections needed, or using grep/search instead of full-file reads for large files.",
				evidence: `${info.tool} at ordinal ${ordinal}: ${info.tokens} tok${info.turnsAfter ? ` × ${info.turnsAfter} turns = ${info.carryTokenTurns?.toLocaleString()} token-turns` : ""}`,
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

		const totalCarry = (carry["totalTokenTurns"] as number) ?? 0;
		if (totalCarry > SESSION_CARRY_THRESHOLD && billed["output"] && billed["output"] > 0) {
			proposals.push({
				target_type: "general",
				title: `High carry-cost session: ${totalCarry.toLocaleString()} token-turns, read amplification ${readAmpl}×`,
				summary: `This session spent ${totalCarry.toLocaleString()} token-turns on carried context (read amplification ${readAmpl}× output).`,
				detail: "Session is dominated by carried context rather than output. Consider breaking long coding sessions into shorter focused ones, using search/grep instead of full reads, and avoiding redundant reads.",
				evidence: `${totalCarry.toLocaleString()} total carry token-turns; ${(billed["cacheRead"] ?? 0).toLocaleString()} cacheRead tokens; read amplification ${readAmpl}×`,
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