import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_USER_ROLE } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "language-mismatch.mismatched-turns",
		name: "Mismatched turns",
		definition: "The number of turn pairs whose assistant response is written in a different script than the user's message.",
		measurement: "rule-based",
		unit: "mismatched turns per session",
		denominator: "judged turns (the node stores the judged turn count): turns where both texts have enough letters of one dominant script",
		values: [
			{ value: "latin", meaning: "Latin letters dominate." },
			{ value: "cyrillic", meaning: "Cyrillic letters dominate." },
			{ value: "greek", meaning: "Greek letters dominate." },
			{ value: "hebrew", meaning: "Hebrew letters dominate." },
			{ value: "arabic", meaning: "Arabic letters dominate." },
			{ value: "devanagari", meaning: "Devanagari letters dominate." },
			{ value: "thai", meaning: "Thai letters dominate." },
			{ value: "japanese", meaning: "Kana, with or without Han, dominate." },
			{ value: "korean", meaning: "Hangul dominates." },
			{ value: "chinese", meaning: "Han alone dominates." },
		],
		limitations: [
			"The check is a Unicode-block heuristic over letters. It sees a script and not a language, so French and English are both latin and never mismatch.",
			"Mixed text, with no script above the dominant ratio, is not judged.",
			"Code, paths and URLs are stripped first, and a text shorter than the configured minimum length (40 letters by default) is not judged.",
			LIMIT_USER_ROLE,
		],
	},
	{
		id: "language-mismatch.mismatched-compactions",
		name: "Mismatched compaction summaries",
		definition: "The number of compaction summaries written in a different script than the conversation they compress.",
		measurement: "rule-based",
		unit: "mismatched summaries per session",
		denominator: "checked compaction summaries (the node stores the checked count)",
		limitations: [
			"The conversation script comes from the user messages of the session, so a session of pasted text in another script misleads it.",
			"The same Unicode-block limits apply as for turns: a script and not a language.",
		],
	},
];
