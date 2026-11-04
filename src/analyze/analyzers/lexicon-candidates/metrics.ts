import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_USER_ROLE } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "lexicon-candidates.nominated-terms",
		name: "Nominated terms and phrases",
		definition: "The distinct normalised words, and the two-word phrases, that a session's user messages put forward for the frustration lexicon to judge, ranked by frequency.",
		measurement: "rule-based",
		unit: "terms and phrases per session",
		denominator: "none: the node also stores the user message count, the distinct token count and the total token count",
		limitations: [
			"Nomination is language-blind by design: it uses no stopword list and no stemming, and only a shape filter drops code, paths, URLs and identifiers. A nominated term is a candidate and not a signal.",
			"Phrases are ranked by frequency under a per-session cap (50 by default), so a rare idiom is never nominated. Single words have no cap in practice.",
			"A term nominated once is judged once for the whole corpus, so the count of nominations is not the count of model calls.",
			LIMIT_USER_ROLE,
		],
		seriesBreaks: [
			{
				version: "1.2",
				effect: "Phrases were removed, because adjacent words in running prose are not idioms. Nodes of version 1.1 carry phrases that later versions don't.",
				repair: "prospect analyze --analyzer lexicon-candidates --revise minor",
			},
			{
				version: "1.3",
				effect: "Hyphenated compounds are kept whole. Earlier nodes nominated bare prefixes of them.",
				repair: "prospect analyze --analyzer lexicon-candidates --revise minor",
			},
			{
				version: "1.4",
				effect: "Phrases return under a per-session cap, ranked by frequency.",
				repair: "prospect analyze --analyzer lexicon-candidates --revise minor",
			},
		],
	},
];
