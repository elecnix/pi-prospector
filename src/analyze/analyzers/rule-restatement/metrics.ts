import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_VERSIONS } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "rule-restatement.rule-status",
		name: "Rule status",
		definition: "Whether the rule that a proposal suggests is already stated in the instruction files the session ran under, in any wording.",
		measurement: "inferred",
		unit: "proposals per status",
		denominator: "rule-shaped proposals: those whose target is a standing instruction, skill or prompt",
		values: [
			{ value: "gap", meaning: "The instruction corpus does not state the rule." },
			{ value: "partial", meaning: "The corpus states part of the rule, or a weaker form." },
			{ value: "restated", meaning: "The corpus already states the rule. This is an adherence finding: the rule exists and was not followed." },
			{ value: "ungrounded", meaning: "The model said the rule exists, but its quote is not in the corpus, so neither a gap nor a restatement was shown." },
			{ value: "unchecked", meaning: "The proposal is not rule-shaped, no corpus exists on disk, or it has not been judged yet. This is the default." },
		],
		limitations: [
			"A claim that the rule exists must quote it, and the quote is checked verbatim (ignoring whitespace and markup) against the corpus before the model is believed. A model that cannot quote gets ungrounded, which is not a restatement.",
			"The corpus is read from disk as it is now, because transcripts keep no copy. A rule added after the session, or removed since, changes the verdict. Editing a file re-identifies every check that read it.",
			"A session whose harness is unknown gets no harness files, so its verdict covers the configured files only.",
			"When the corpus exceeds the budget, the passages that share the most terms with the proposal are read. The node records that it was excerpted, and a rule outside those passages reads as a gap.",
			"The verdict judges what the instructions say and not whether the agent followed them. Replay validation can't tell a new rule from a restated one, and this check can.",
			"The model's answer before grounding is stored as the model verdict (restated, partial or gap). The status is the verdict after grounding.",
			LIMIT_VERSIONS,
		],
	},
];
