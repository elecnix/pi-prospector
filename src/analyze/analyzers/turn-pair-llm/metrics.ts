import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_VERSIONS } from "../../metrics/limits.js";

const REPAIR_FULL = "prospect analyze --analyzer turn-pair-llm --revise major,minor (costs model calls)";

export const metrics: MetricDefinition[] = [
	{
		id: "turn-pair-llm.friction-type",
		name: "Friction type",
		definition: "The kind of friction in one turn, judged from the user and assistant text, the tool calls and the error heads.",
		measurement: "inferred",
		unit: "classified turns per type",
		denominator: "classified turns: the turns that the analyzer's version chose to escalate, not all turns",
		values: [
			{ value: "none", meaning: "No friction." },
			{ value: "wrong_approach", meaning: "The agent took a method the user did not want." },
			{ value: "missed_instruction", meaning: "The agent ignored an instruction already given." },
			{ value: "tool_misuse", meaning: "The agent used a tool with wrong arguments or against the wrong target." },
			{ value: "repetition", meaning: "The user had to ask again." },
			{ value: "rebuttal", meaning: "The user disputes whether something the assistant said is true." },
			{ value: "other", meaning: "Friction that fits no other value." },
		],
		limitations: [
			"A share such as \"tool_misuse is 8 percent of classified turns\" describes the selection of turns the version escalated, and a change of selection, prompt, evidence or model moves every share with no change in behaviour.",
			"The judgement belongs to the resolved model, which the node records. A change of the model that a tier resolves to is a config change, and shares from different models don't compare.",
			"Failed calls leave error nodes, and an error node is not a classification, so a count of nodes overstates the count of classified turns. Count nodes of kind classification.",
			LIMIT_VERSIONS,
		],
		seriesBreaks: [
			{
				version: "1.3",
				effect: "The prompt carries the turn's tool calls and error heads, so the share of tool_misuse changes.",
				repair: REPAIR_FULL,
			},
			{
				version: "1.4",
				effect: "A turn that matches a frustration signal is escalated even when its score is low. The classified population grows toward turns without tools, so every share shifts. Nothing is recomputed, because the unit identity is unchanged.",
				repair: "prospect analyze --backfill-missing fills the newly escalated turns",
			},
			{
				version: "1.5",
				effect: "The prompt carries the turns since the previous trigger point and not the turn alone, so the evidence the model sees changes.",
				repair: REPAIR_FULL,
			},
			{
				version: "1.6",
				effect: "The rebuttal type exists. Earlier nodes cannot return it.",
				repair: REPAIR_FULL,
			},
			{
				version: "1.8",
				effect: "The frustration boost that selects turns reads the hits that count: current generation, unmuted and priced by term specificity.",
				repair: REPAIR_FULL,
			},
		],
	},
	{
		id: "turn-pair-llm.sentiment",
		name: "Sentiment",
		definition: "The user's sentiment in one turn: positive, neutral or frustrated.",
		measurement: "inferred",
		unit: "classified turns per value",
		denominator: "classified turns",
		values: [
			{ value: "positive", meaning: "The user expresses approval." },
			{ value: "neutral", meaning: "No sentiment, or a plain instruction." },
			{ value: "frustrated", meaning: "The user expresses frustration." },
		],
		limitations: [
			"The same selection and model limits as the friction type apply, since both come from one classification.",
			LIMIT_VERSIONS,
		],
	},
];
