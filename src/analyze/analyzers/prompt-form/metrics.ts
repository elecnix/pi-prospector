import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_USER_ROLE } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "prompt-form.prompt-kind",
		name: "Prompt kind",
		definition: "What the person is doing in a typed prompt: asking a question, giving an instruction, correcting the assistant, or something else. The kind is a classifier's answer, or unknown when none exists.",
		measurement: "inferred",
		unit: "typed prompts per kind",
		denominator: "typed prompts with words of the person's own: messages settled as typed, after pasted and quoted text is cut",
		values: [
			{ value: "question", meaning: "Asking for information or an explanation." },
			{ value: "instruction", meaning: "Asking the assistant to do something, including approving a step." },
			{ value: "correction", meaning: "Saying the assistant was wrong or must redo something." },
			{ value: "other", meaning: "A greeting, thanks, a remark, or text that asks for nothing." },
			{ value: "unknown", meaning: "No classifier answer exists for the prompt." },
		],
		limitations: [
			"The answer comes from the message-answers layer, which needs a configured decision model. Without one every kind is unknown, and unknown is never counted as other.",
			"No punctuation is read, so a question without a question mark is still a question.",
			"A message with an undecided origin is counted apart in the node and is not read.",
			LIMIT_USER_ROLE,
		],
	},
	{
		id: "prompt-form.prompt-length",
		name: "Prompt length",
		definition: "The length in characters of the person's own words in typed prompts: sum, median, 90th percentile, maximum, and a bucket histogram.",
		measurement: "counted",
		unit: "characters per session",
		denominator: "typed prompts with words of the person's own",
		limitations: [
			"The median, percentile and maximum are null for a session with no typed message, and the counts are zero. Null means no data, and zero means a session with none.",
			"Text the person pasted or quoted is cut, so a prompt that is mostly a pasted log counts only its own words.",
			"Characters are not tokens, and scripts differ in how much a character holds.",
			LIMIT_USER_ROLE,
		],
	},
	{
		id: "prompt-form.prompt-structure",
		name: "Prompt structure",
		definition: "How many typed prompts hold a list, a heading, or a code block.",
		measurement: "counted",
		unit: "prompts per session, per structure",
		denominator: "typed prompts with words of the person's own",
		limitations: [
			"A code block (a fenced block) counts wherever it sits in the message and whoever wrote it, because it is a fact about the form of the message. A list and a heading are read from the person's own words only.",
			"A list needs a configured minimum number of bullet or numbered lines, and a heading is a markdown heading, so plain text that looks like either does not count.",
			LIMIT_USER_ROLE,
		],
	},
];
