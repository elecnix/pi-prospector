import { newestPerSession, type FingerprintContributor } from "../../../fingerprint/contributor.js";

/**
 * The tools a session carried in its request prefix and never called. Counted
 * from the inventory the host recorded at session start, so objective. Only a
 * session with a recorded inventory gets a node, so a session without one is
 * not measured rather than read as carrying no tools. Tool names stay out: they
 * name a person's setup.
 */
export const toolInventoryTaxFingerprint: FingerprintContributor = {
	def: {
		id: "toolInventory",
		label: "Tool inventory",
		description:
			"Tools available to a session and tools it called, the definitions of the unused ones re-sent on every billed turn (token-turns), and their estimated cost where turns carry a price. Only sessions whose host recorded a tool inventory are measured.",
		kind: "objective",
		analyzers: ["tool-inventory-tax"],
		measures: [
			{ kind: "total", id: "availableTools", metric: "tool-inventory-tax.unused-prefix", field: "available" },
			{ kind: "total", id: "invokedTools", metric: "tool-inventory-tax.unused-prefix", field: "invoked" },
			{ kind: "total", id: "unusedTools", metric: "tool-inventory-tax.unused-prefix", field: "unused" },
			{ kind: "total", id: "unusedPrefixMillionTokenTurns", metric: "tool-inventory-tax.estimated-tax", field: "tokenTurns", divisor: 1_000_000, decimals: 2 },
			{ kind: "total", id: "estimatedTaxUsd", metric: "tool-inventory-tax.estimated-tax", field: "usd", decimals: 2 },
		],
	},
	async read(ctx) {
		const rows = newestPerSession(
			await ctx.nodes("tool-inventory-tax", {
				available: "$.available_tools",
				invoked: "$.invoked_tools",
				unused: "$.unused_tools",
				tokenTurns: "$.unused_prefix_token_turns",
				usd: "$.estimated_tax_usd",
			}),
			"available",
		);
		return { measured: rows.map((r) => String(r["session"])), rows };
	},
};
