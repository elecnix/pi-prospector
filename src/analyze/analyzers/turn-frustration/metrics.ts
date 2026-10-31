import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_USER_ROLE, LIMIT_VERSIONS } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "turn-frustration.frustration-hit",
		name: "Frustration hit",
		definition: "One turn and one signal: the user text of the turn matched a lexicon word or phrase, a dictionary entry, or a paralinguistic marker.",
		measurement: "rule-based",
		unit: "hits per 100 turns",
		denominator: "turns of the sessions that turn-frustration read",
		limitations: [
			"Coverage decides the number: a month where turn-frustration read few sessions describes only those sessions.",
			"A hit matches against lexicon verdicts that a model inferred, so the category of a hit is only as good as the verdict behind it.",
			"A hit node stores its intrinsic weight, and a reader scales it by how specific the term is in the corpus, so one stored hit can count differently as the corpus grows. A muted term stops counting.",
			"Hits drawn before version 1.10 have no origin label, so they may match pasted text.",
			LIMIT_USER_ROLE,
			LIMIT_VERSIONS,
		],
		seriesBreaks: [
			{
				version: "1.8",
				effect: "A hit copies the category the lexicon now gives it, so profanity counts fall and insult counts appear.",
				repair: "prospect analyze --analyzer frustration-lexicon --revise minor --revise-where category=profanity, then the same for turn-frustration",
			},
			{
				version: "1.10",
				effect: "A hit records the origin of the text it matched. Earlier hits have no origin.",
				repair: "prospect analyze --analyzer turn-frustration --revise minor",
			},
		],
	},
	{
		id: "turn-frustration.paralinguistic-marker",
		name: "Paralinguistic marker",
		definition: "Frustration expressed by form, such as shouting or repeated punctuation, matched with no lexicon and no language.",
		measurement: "rule-based",
		unit: "hits per 100 turns",
		denominator: "turns of the sessions that turn-frustration read",
		limitations: [
			"A pasted log in capitals counts as shouting unless the origin label marks it as pasted.",
			LIMIT_USER_ROLE,
		],
	},
	{
		id: "turn-frustration.hit-origin",
		name: "Text origin of a hit",
		definition: "The label on the text a hit matched, saying who wrote it, with the occurrences per label.",
		measurement: "rule-based",
		unit: "occurrences per label",
		denominator: "occurrences in a hit; they add up to the hit's count",
		values: [
			{ value: "typed", meaning: "The person wrote it." },
			{ value: "pasted", meaning: "The person sent copied material." },
			{ value: "quoted", meaning: "The text quotes earlier text." },
			{ value: "agent", meaning: "Another agent wrote or relayed it." },
			{ value: "notification", meaning: "The harness injected it." },
			{ value: "fork-copy", meaning: "A fork copied it from its parent session." },
		],
		limitations: [
			"The rules are heuristics over the transcript, and a person who pastes an earlier message of their own gets pasted.",
			"Only hits of version 1.10 and later have the label. The message-origin analyzer labels whole messages for any metric.",
		],
	},
];
