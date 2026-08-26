/**
 * tool-inventory-tax — a deterministic, session-level analyzer that prices the
 * tools a session *carried* but never called (#70).
 *
 * Every tool definition sits in the request prefix of every billed turn,
 * whether or not the tool is ever invoked. The waste is fixed and countable:
 *
 *   - Available side: the session's recorded **tool inventory** (`sessions.tool_inventory`,
 *     captured at sync time from the host's session-start manifest, with each
 *     tool's serialized definition size).
 *   - Invoked side: distinct `name` values across `messages.tool_calls`.
 *   - The tax = the set difference, priced across the session's billed turns.
 *
 * Pricing method (documented estimate, no invented rates): the per-bucket
 * dollar cost captured alongside each turn's usage implies a per-token price
 * per bucket. The static prefix was present from session start, so
 *
 *   - on a **rebuild** turn (cacheRead == 0 — the first billed turn, or the
 *     first turn after a compaction) it was paid as input or cacheWrite;
 *     price it at that turn's blended (input + cacheWrite) dollars-per-token;
 *   - on every other billed turn it rode along as cacheRead; price it at that
 *     turn's own implied cacheRead dollars-per-token.
 *
 * A turn whose usage carries no per-bucket cost breakdown contributes nothing
 * to the dollar figure and is counted as unpriced (never silently zero). When
 * *no* turn is priced the dollar estimate is null and only token-turns carry
 * the finding ("token-turns-only"), by the same honesty rule as Billed cost.
 * Tools whose manifest entry lacks `definitionChars` contribute 0 chars but
 * still count, so a dollar figure over such tools is a documented LOWER BOUND.
 *
 * Sessions whose inventory was never captured (NULL = UNKNOWN) are skipped —
 * never read as "no tools available", which would be confidently wrong across
 * all history (DESIGN.md, Tool Inventory).
 *
 * One node per inventoried session: metric when the tax is immaterial;
 * when the estimated tax clears the config threshold (or, unpriced sessions,
 * the token-turn fallback), the node carries `improvement_proposals` and is
 * emitted as kind `proposal`, following the files-in-play/uncompleted-leads
 * convention for deterministic analyzers.
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
import {
	DEFAULT_TOOL_INVENTORY_TAX_CONFIG,
	type ToolInventoryTaxConfig,
} from "./config.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { Type, type Static } from "typebox";
import type { CostInfo } from "../../../types.js";

// ── emitted-node schema ──

/** A proposal this analyzer embeds in its node; materialised by the framework. */
export const ToolInventoryTaxRawProposal = Type.Object({
	target_type: Type.String(),
	target_path: Type.Optional(Type.String()),
	title: Type.String(),
	summary: Type.String(),
	detail: Type.String(),
	evidence: Type.String(),
	confidence: Type.Number(),
	severity: Type.String(),
});
export type ToolInventoryTaxRawProposal = Static<typeof ToolInventoryTaxRawProposal>;

const PricingMethod = Type.Union([
	Type.Literal("per-turn-implied-rates"),
	Type.Literal("token-turns-only"),
]);

/** The properties a tool-inventory-tax node carries in its `contentJson`. */
export const TOOL_INVENTORY_TAX_PROPERTIES = Type.Object({
	session_id: Type.String(),
	/** Where the manifest came from (e.g. "pi-session-header"). */
	inventory_source: Type.String(),
	/** Tools the session had available. */
	available_tools: Type.Number(),
	/** Distinct tools actually invoked via messages.tool_calls. */
	invoked_tools: Type.Number(),
	/** Available-but-never-invoked tools. */
	unused_tools: Type.Number(),
	/** Never-invoked tool names, capped at maxNamedTools. */
	unused_tool_names: Type.Array(Type.String()),
	/** Never-invoked tools whose manifest carried no definitionChars. */
	unsized_unused_tools: Type.Number(),
	/** Serialized character length of the unused definitions (lower bound when unsized_unused_tools > 0). */
	unused_definition_chars: Type.Number(),
	/** Estimated token footprint of the unused prefix (charsPerToken estimate). */
	unused_prefix_tokens: Type.Number(),
	/** Assistant turns billed this session. */
	billed_turns: Type.Number(),
	/** Turns whose pricing contributed to the dollar figure. */
	priced_turns: Type.Number(),
	/** Turns with no usable per-bucket cost breakdown — excluded, never zero-priced. */
	unpriced_turns: Type.Number(),
	/** The priced prefix tax, or null when no turn could be priced. */
	estimated_tax_usd: Type.Union([Type.Number(), Type.Null()]),
	/** Which estimate produced estimated_tax_usd. */
	pricing_method: PricingMethod,
	/** Prefix tokens × billed turns — the honest unit when dollars are unavailable. */
	unused_prefix_token_turns: Type.Number(),
	improvement_proposals: Type.Array(ToolInventoryTaxRawProposal),
});
export type ToolInventoryTaxProperties = Static<typeof TOOL_INVENTORY_TAX_PROPERTIES>;

export const TOOL_INVENTORY_TAX_DEF: AnalyzerDef = {
	id: "tool-inventory-tax",
	label: "Tool Inventory Tax (deterministic)",
	description:
		"Prices the tools a session had available but never invoked: the set difference between the recorded tool inventory and the distinct tool_calls names, with the unused definitions' static prefix cost estimated across the session's billed turns from their per-bucket dollar costs. No LLM.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: TOOL_INVENTORY_TAX_PROPERTIES,
};

export const TOOL_INVENTORY_TAX_VERSION: AnalyzerVersion = {
	analyzerId: TOOL_INVENTORY_TAX_DEF.id,
	// 1.0 (issue #70): set difference between the synced tool inventory and the
	// invoked tool_calls names, with the unused definitions' prefix cost priced
	// from per-bucket implied rates across billed turns.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/tool-inventory-tax/index.ts",
};

// ── pure computation ──

/** One tool the session had available, as stored in the manifest. */
export interface InventoryTool {
	name: string;
	definitionChars: number | null;
}

/** Parsed shape of `sessions.tool_inventory`. NULL means UNKNOWN upstream. */
export interface ParsedInventory {
	source: string;
	tools: InventoryTool[];
}

/** Per-turn billing inputs the pricing reads (from messages.usage). */
export interface TurnBilling {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	/** Per-bucket billed dollars, or null when the host reported none. */
	cost: Pick<CostInfo, "input" | "output" | "cacheRead" | "cacheWrite"> | null;
}

/** The pricing half of the node's content. */
export interface TaxEstimate {
	taxUsd: number | null;
	pricedTurns: number;
	unpricedTurns: number;
	method: "per-turn-implied-rates" | "token-turns-only";
}

/** Distinct invoked tool names across a session's raw tool_calls JSON blobs. */
export function collectInvokedToolNames(rows: ReadonlyArray<{ tool_calls: string | null }>): Set<string> {
	const invoked = new Set<string>();
	for (const row of rows) {
		if (!row.tool_calls) continue;
		const calls = JSON.parse(row.tool_calls) as Array<{ name?: unknown }>;
		for (const c of calls) {
			if (typeof c.name === "string" && c.name !== "") invoked.add(c.name);
		}
	}
	return invoked;
}

/** Parse a stored tool_inventory blob. Callers must have excluded NULL already. */
export function parseToolInventory(json: string): ParsedInventory {
	const parsed = JSON.parse(json) as { source?: unknown; tools?: unknown };
	if (!Array.isArray(parsed.tools)) {
		throw new Error("tool-inventory-tax: malformed tool_inventory (missing tools array)");
	}
	if (typeof parsed.source !== "string") {
		throw new Error("tool-inventory-tax: malformed tool_inventory (missing source)");
	}
	return {
		source: parsed.source,
		tools: parsed.tools.map((t) => {
			const entry = t as { name?: unknown; definitionChars?: unknown };
			if (typeof entry.name !== "string") {
				throw new Error("tool-inventory-tax: malformed tool_inventory entry (name)");
			}
			return {
				name: entry.name,
				definitionChars:
					typeof entry.definitionChars === "number" && Number.isFinite(entry.definitionChars)
						? entry.definitionChars
						: null,
			};
		}),
	};
}

/**
 * The set difference: available tools whose name was never invoked, plus the
 * aggregate sizing of the unused definitions. Unsized entries contribute 0
 * characters but stay counted, so the char total is an honest lower bound.
 */
export function computeUnusedTools(
	tools: ReadonlyArray<InventoryTool>,
	invoked: ReadonlySet<string>,
): { unused: InventoryTool[]; definitionChars: number; unsizedCount: number } {
	const unused = tools.filter((t) => !invoked.has(t.name));
	let definitionChars = 0;
	let unsizedCount = 0;
	for (const t of unused) {
		if (t.definitionChars === null) unsizedCount++;
		else definitionChars += t.definitionChars;
	}
	return { unused, definitionChars, unsizedCount };
}

/**
 * Price the static prefix across billed turns using each turn's own implied
 * per-token rate. Rebuild turns (cacheRead == 0) paid the prefix as input or
 * cacheWrite; carry turns paid it as cacheRead. Turns without a per-bucket
 * cost breakdown are excluded from the dollar figure and counted, never
 * zero-priced. When nothing can be priced, taxUsd is null.
 */
export function estimateTax(prefixTokens: number, turns: ReadonlyArray<TurnBilling>): TaxEstimate {
	let total = 0;
	let pricedTurns = 0;
	let unpricedTurns = 0;
	for (const t of turns) {
		if (t.cacheRead <= 0) {
			const denom = t.input + t.cacheWrite;
			if (t.cost && denom > 0) {
				total += prefixTokens * ((t.cost.input + t.cost.cacheWrite) / denom);
				pricedTurns++;
			} else {
				unpricedTurns++;
			}
		} else if (t.cost && t.cacheRead > 0) {
			total += prefixTokens * (t.cost.cacheRead / t.cacheRead);
			pricedTurns++;
		} else {
			unpricedTurns++;
		}
	}
	const rounded = Math.round(total * 1e6) / 1e6;
	return {
		taxUsd: pricedTurns > 0 ? rounded : null,
		pricedTurns,
		unpricedTurns,
		method: pricedTurns > 0 ? "per-turn-implied-rates" : "token-turns-only",
	};
}

// ── config ──

function resolveConfig(raw: unknown): ToolInventoryTaxConfig {
	return (raw as ToolInventoryTaxConfig) ?? DEFAULT_TOOL_INVENTORY_TAX_CONFIG;
}

// ── plan-time row shapes (MessageRow does not carry the usage column) ──

interface BillingRow {
	role: string;
	usage: string | null;
}

function parseBilling(row: BillingRow): TurnBilling | null {
	if (row.role !== "assistant" || !row.usage) return null;
	const u = JSON.parse(row.usage) as Record<string, unknown>;
	const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	const costObj = u["cost"] as Record<string, unknown> | null | undefined;
	const cost =
		costObj && typeof costObj === "object"
			? {
					input: num(costObj["input"]),
					output: num(costObj["output"]),
					cacheRead: num(costObj["cacheRead"]),
					cacheWrite: num(costObj["cacheWrite"]),
				}
			: null;
	return {
		input: num(u["input"]),
		cacheRead: num(u["cacheRead"]),
		cacheWrite: num(u["cacheWrite"]),
		cost,
	};
}

// ── proposal ──

function buildProposal(props: Omit<ToolInventoryTaxProperties, "improvement_proposals">, cfg: ToolInventoryTaxConfig): ToolInventoryTaxRawProposal | null {
	const material =
		props.unused_tools >= 1 &&
		(props.estimated_tax_usd !== null
			? props.estimated_tax_usd >= cfg.materialTaxUsd
			: props.unused_prefix_token_turns >= cfg.materialTokenTurns);
	if (!material) return null;

	const named = props.unused_tool_names.join(", ");
	const more = props.unused_tools - named.split(", ").length;
	const suffix = more > 0 ? `, and ${more} more` : "";
	const usd =
		props.estimated_tax_usd !== null
			? `$${props.estimated_tax_usd.toFixed(4)}`
			: `${props.unused_prefix_token_turns.toLocaleString()} token-turns (no per-bucket cost recorded to price dollars)`;
	const boundNote =
		props.unsized_unused_tools > 0
			? ` LOWER BOUND: ${props.unsized_unused_tools} of the unused definitions carried no recorded size.`
			: "";

	return {
		target_type: "config",
		title: `${props.unused_tools} of ${props.available_tools} carried tools were never called — ${usd} of prefix tax`,
		summary:
			`${props.unused_tools} tool${props.unused_tools === 1 ? "" : "s"} sat in this session's request prefix without ever being invoked ` +
			`(${named}${suffix}). Their static definitions were re-billed on all ${props.billed_turns} billed turn(s); the estimated tax is ${usd}.${boundNote}`,
		detail:
			"A tool's full definition — name, description, parameter schema — rides in the prefix of every request whether or not it is ever called. " +
			"This waste is fixed: removing an unused tool server pays out on every future session, unconditionally. Disable or disconnect servers whose tools went uncalled, or trim oversized definitions." +
			(boundNote ? " Note: the dollar figure counts only definitions with a recorded size." : ""),
		evidence:
			`${props.unused_tools}/${props.available_tools} tools unused (${named}${suffix}); ` +
			`${props.unused_definition_chars.toLocaleString()} chars ≈ ${props.unused_prefix_tokens.toLocaleString()} tokens × ${props.billed_turns} billed turn(s); ` +
			`estimated ${usd} via ${props.pricing_method}`,
		confidence: 0.8,
		severity: "waste",
	};
}

// ── analyzer ──

export const toolInventoryTaxAnalyzer: Analyzer = {
	def: TOOL_INVENTORY_TAX_DEF,
	version: TOOL_INVENTORY_TAX_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: TOOL_INVENTORY_TAX_DEF.id,
		configHash: computeConfigHash(DEFAULT_TOOL_INVENTORY_TAX_CONFIG),
		configJson: DEFAULT_TOOL_INVENTORY_TAX_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		if (ctx.messages.length === 0) return [];

		// UNKNOWN inventory (NULL) → skip honestly. It must never be read as
		// "no tools available": a tax computed against an assumed-empty inventory
		// would be confidently wrong across all history and would look real.
		const sessRow = (await ctx.db.prepare("SELECT tool_inventory FROM sessions WHERE id = ?").get(ctx.sessionId)) as
			| { tool_inventory: string | null }
			| undefined;
		if (!sessRow || sessRow.tool_inventory === null) return [];

		const inventory = parseToolInventory(sessRow.tool_inventory);

		const rows = (await ctx.db
			.prepare("SELECT role, tool_calls, usage FROM messages WHERE session_id = ? ORDER BY rowid ASC")
			.all(ctx.sessionId)) as Array<{ role: string; tool_calls: string | null; usage: string | null }>;

		const invoked = collectInvokedToolNames(rows);
		const { unused, definitionChars, unsizedCount } = computeUnusedTools(inventory.tools, invoked);

		const cfg = resolveConfig(ctx.config);
		const turns: TurnBilling[] = [];
		for (const r of rows) {
			const b = parseBilling(r);
			if (b) turns.push(b);
		}
		const billedTurns = turns.length;

		const prefixTokens = Math.round(definitionChars / cfg.charsPerToken);
		const est = estimateTax(prefixTokens, turns);

		const properties: Omit<ToolInventoryTaxProperties, "improvement_proposals"> = {
			session_id: ctx.sessionId,
			inventory_source: inventory.source,
			available_tools: inventory.tools.length,
			invoked_tools: invoked.size,
			unused_tools: unused.length,
			unused_tool_names: unused.slice(0, cfg.maxNamedTools).map((t) => t.name),
			unsized_unused_tools: unsizedCount,
			unused_definition_chars: definitionChars,
			unused_prefix_tokens: prefixTokens,
			billed_turns: billedTurns,
			priced_turns: est.pricedTurns,
			unpriced_turns: est.unpricedTurns,
			estimated_tax_usd: est.taxUsd,
			pricing_method: est.method,
			unused_prefix_token_turns: Math.round(prefixTokens * billedTurns),
		};

		// Fingerprint everything the node's content depends on: the inventory
		// itself, the invoked names, and the per-turn billing inputs. Deliberately
		// config-free — thresholds belong to the framework's config identity axis,
		// so changing one marks prior nodes stale for the `config` reason instead
		// of re-identifying as missing.
		const fpLines = [
			`inventory:${JSON.stringify(inventory)}`,
			`invoked:${[...invoked].sort().join("|")}`,
			...turns.map((t, i) => `t${i}:${t.input}:${t.cacheRead}:${t.cacheWrite}:${JSON.stringify(t.cost)}`),
		];
		const fingerprint = shortHash(fpLines.join("\n"));
		const sources: SourceRef[] = [{ kind: "session", id: `${ctx.sessionId}#tool-inventory-tax=${fingerprint}` }];

		return [
			{
				sources,
				sourceSetHash: shortHash(`tool-inventory-tax(${ctx.sessionId}|${fingerprint})`),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
				meta: { result: properties },
			},
		];
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const cfg = resolveConfig(ctx.config.configJson);
		const result = (unit.meta?.["result"] ?? {}) as Omit<ToolInventoryTaxProperties, "improvement_proposals">;
		const proposal = buildProposal(result, cfg);

		const contentJson: ToolInventoryTaxProperties = { ...result, improvement_proposals: proposal ? [proposal] : [] };

		return {
			nodeKind: proposal ? "proposal" : "metric",
			contentJson: contentJson as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			edges: [
				{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
			],
		};
	},
};
