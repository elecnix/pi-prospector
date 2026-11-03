import type { MetricDefinition } from "../../metrics/types.js";

export const metrics: MetricDefinition[] = [
	{
		id: "similarity-cluster.cluster",
		name: "Similarity cluster",
		definition: "A group of near-duplicate user prompts, normalised tool calls or tool results, found within one session or across sessions that share a repository.",
		measurement: "rule-based",
		unit: "clusters per session, with the size and the mean similarity of each",
		denominator: "none",
		values: [
			{ value: "user_prompt", meaning: "The members are user prompts." },
			{ value: "tool_call", meaning: "The members are normalised tool calls." },
			{ value: "tool_result", meaning: "The members are tool results." },
		],
		limitations: [
			"Candidates come from a rarest-shingle index, then length-band pruning and a longest-common-subsequence score. A pair the index never nominated is a blind spot, and the node counts blind items.",
			"Exact-hash classes are transitive and near-miss pairs are not, so a cluster of near-misses can hold two members that are far apart.",
			"Cross-session scope pools sibling sessions of one repository up to a configured maximum, taken in id order, so a repository with more sessions than the maximum is only partly compared.",
			"The sibling sessions are part of the unit's source set, so adding or editing a sibling re-identifies the unit. A new run fills it as missing work and does not revise the old node.",
			"A cluster of prompts is not evidence of friction by itself: a person who repeats a task in several sessions produces one.",
		],
	},
];
