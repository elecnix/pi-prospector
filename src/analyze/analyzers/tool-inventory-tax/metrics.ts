import type { MetricDefinition } from "../../metrics/types.js";

export const metrics: MetricDefinition[] = [
	{
		id: "tool-inventory-tax.unused-prefix",
		name: "Unused tool prefix",
		definition: "The tools a session had available but never called, with the serialized size of their definitions and the token footprint of that size.",
		measurement: "counted",
		unit: "unused tools, characters and estimated tokens per session",
		denominator: "tools available in the session",
		limitations: [
			"The tool inventory cannot be backfilled: sync captures it from what the host persists at session start. A session recorded without a manifest has no inventory, is skipped, and never reads as having no tools available.",
			"A tool whose manifest entry lacks a definition size counts as unused but adds zero characters, so the size is a lower bound. The node counts those tools.",
			"The token footprint is estimated from characters with a configurable ratio.",
		],
	},
	{
		id: "tool-inventory-tax.estimated-tax",
		name: "Estimated inventory tax",
		definition: "The cost of re-sending the unused tool definitions on every billed turn, priced from each turn's implied rate.",
		measurement: "rule-based",
		unit: "dollars per session, or token-turns when no turn can be priced",
		denominator: "none",
		values: [
			{ value: "per-turn-implied-rates", meaning: "The tax is in dollars, priced from the per-bucket cost of the turns that have a breakdown." },
			{ value: "token-turns-only", meaning: "No turn could be priced, so the dollar figure is null and only prefix tokens multiplied by billed turns is reported." },
		],
		limitations: [
			"A turn without a per-bucket cost breakdown is excluded and counted as unpriced, never priced at zero.",
			"The dollar figure is a lower bound when some unused tools have no definition size.",
			"Only some harnesses record a billed cost, so the dollar figure exists for those harnesses only.",
		],
	},
];
