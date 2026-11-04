import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_HARNESS } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "decode-collapse.collapsed-documents",
		name: "Decode-collapsed documents",
		definition: "The number of documents (an assistant message's reasoning or its answer text, each judged separately) whose median line perplexity exceeds the corpus-calibrated threshold, so the generation stopped being language.",
		measurement: "rule-based",
		unit: "collapsed documents per session",
		denominator: "none: the node also stores the count of scored documents",
		limitations: [
			"A corpus too small to train on yields null, which means unknown, and never zero.",
			"The threshold derives from held-out sessions of this corpus and is not a configured perplexity, so the same text can score differently in another corpus.",
			"The threshold is a ranking aid. The node lists the highest-scoring documents so a person can confirm them, and a recall figure built from the detector's own ranking would be circular.",
			"The model trains on the earliest sessions of the index, up to a cap, so a session is always scored by a model that never saw it.",
			LIMIT_HARNESS,
		],
	},
	{
		id: "decode-collapse.median-perplexity",
		name: "Median document perplexity",
		definition: "The median over a session's scored documents of each document's median line perplexity under the corpus word n-gram model.",
		measurement: "rule-based",
		unit: "perplexity per session",
		denominator: "none: one value per session, null when the corpus could not support a score",
		limitations: [
			"The value depends on the reference corpus, so it compares only inside one corpus and one reference state.",
			"A coherent turn that quotes a foreign block reads as the turn it is, because the median is taken over lines, but a short document has few lines to take a median over.",
		],
	},
];
