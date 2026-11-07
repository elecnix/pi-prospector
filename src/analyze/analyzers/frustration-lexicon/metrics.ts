import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_VERSIONS } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "frustration-lexicon.lexicon-verdict",
		name: "Lexicon verdict",
		definition: "The judgement on one normalised word or phrase: a polarity (frustration, praise or neutral), a category, a language, a confidence and a rationale.",
		measurement: "inferred",
		unit: "terms",
		denominator: "none",
		values: [
			{ value: "profanity", meaning: "Swearing that names no one." },
			{ value: "insult", meaning: "A word that names or demeans the assistant or its work." },
			{ value: "negation", meaning: "A negation that signals a rejection." },
			{ value: "correction", meaning: "A word that corrects the agent." },
			{ value: "repetition", meaning: "A word that asks the agent to repeat or redo." },
			{ value: "urgency", meaning: "A word that presses for speed." },
			{ value: "confusion", meaning: "A word that shows the user is lost." },
			{ value: "dissatisfaction", meaning: "A word that shows displeasure." },
			{ value: "praise", meaning: "A word that shows approval." },
		],
		limitations: [
			"A model judges each term once for the whole corpus, so a verdict reflects the model and the version of the day the term was first nominated, and it lasts until a revise run recomputes it.",
			"A term filed under an earlier category keeps that category until revised. A revise filter lets a run recompute only the affected terms.",
			LIMIT_VERSIONS,
		],
		seriesBreaks: [
			{
				version: "1.7",
				effect: "Insult is split from profanity. Terms filed as profanity before keep that category until revised.",
				repair: "prospect analyze --analyzer frustration-lexicon --revise minor --revise-where category=profanity",
			},
		],
	},
];
