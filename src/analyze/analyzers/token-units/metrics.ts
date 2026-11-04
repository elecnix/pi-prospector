import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_HARNESS, LIMIT_PARALLEL } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "token-units.mite",
		name: "Token units (MITE)",
		definition: "A session priced in million input-token equivalents: input tokens weigh 1, output 15, cache-read 0.1 and cache-write 1.25 by default.",
		measurement: "counted",
		unit: "MITE per session, per request segment, per model or per day",
		denominator: "none",
		limitations: [
			"The weights are a convention in config and not any provider's price list. The cache-write weight is the conventional 1.25 for a five-minute write, and a corpus billed differently restates it. A change of weights is a config change.",
			"Claude Code writes one row per content block, so rows are folded by provider message id and one API call counts once. A row with no provider id falls back to its own row id, and the node counts those rows.",
			"A call whose transcript recorded no usage is unknown and counted in the coverage fields, never as zero.",
			LIMIT_HARNESS,
			LIMIT_PARALLEL,
		],
	},
];
