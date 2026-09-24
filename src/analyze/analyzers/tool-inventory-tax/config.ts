/**
 * Configuration for the tool-inventory-tax analyzer (#70).
 *
 * Every knob is part of the config fingerprint (DESIGN.md: everything the user
 * sets is config, and a different config "is just different") — changing any of
 * these marks prior nodes stale for the `config` reason; a plain fill leaves
 * them alone and `--revise config` recomputes them with lineage preserved.
 */

import { Type, type Static } from "typebox";

export const ToolInventoryTaxConfig = Type.Object({
	/**
	 * Characters per token used to convert a tool definition's serialized
	 * character length into the token estimate that is priced. Same estimate
	 * convention as context-economy's carry figures.
	 */
	charsPerToken: Type.Number({ exclusiveMinimum: 0 }),
	/**
	 * The estimated dollar tax at or above which the finding earns a proposal.
	 * Below this (or when no turn carried a per-bucket cost breakdown) the node
	 * stays a clean metric — a proposal on a few cents would be noise.
	 */
	materialTaxUsd: Type.Number({ minimum: 0 }),
	/**
	 * Fallback materiality gate in token-turns, used only when no billed turn
	 * carries a per-bucket cost breakdown (`pricingMethod` =
	 * "token-turns-only"), so an unpriced session can still surface a large tax.
	 */
	materialTokenTurns: Type.Number({ minimum: 0 }),
	/** Cap on how many never-called tool names the node names, so node size is bounded. */
	maxNamedTools: Type.Integer({ minimum: 1 }),
});

export type ToolInventoryTaxConfig = Static<typeof ToolInventoryTaxConfig>;

export const DEFAULT_TOOL_INVENTORY_TAX_CONFIG: ToolInventoryTaxConfig = {
	charsPerToken: 3.5,
	// Ten cents of pure prefix waste in one session is worth a checkbox.
	materialTaxUsd: 0.1,
	materialTokenTurns: 100_000,
	maxNamedTools: 12,
};
