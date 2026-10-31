import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_CALL_ID, LIMIT_HARNESS } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "failure-modes.tool-failure",
		name: "Tool failure",
		definition: "A well-formed tool call that the tool refused or errored on.",
		measurement: "rule-based",
		unit: "failures per session",
		denominator: "tool calls (the node stores the failure count and the tool call count)",
		limitations: [
			"A call with no result is unfinished and not failed.",
			"The failure is the result's error flag, which each harness sets by its own rules.",
			LIMIT_CALL_ID,
			LIMIT_HARNESS,
		],
		seriesBreaks: [
			{
				version: "1.3",
				effect: "The action stream pairs results with id-less stored calls. Nodes of version 1.2 and earlier for sessions indexed before call ids understate failures. A revise run fills new nodes beside the old ones and does not replace them, because the unit fingerprint changes.",
				repair: "prospect analyze --analyzer failure-modes --revise minor, then read one node per session or run prospect gc --analyzer failure-modes first",
			},
		],
	},
	{
		id: "failure-modes.turn-failure",
		name: "Turn failure",
		definition: "An assistant generation that ended in a recorded failure, so no tool ran: a provider refusal, a dropped connection, a context ceiling or an operator abort.",
		measurement: "rule-based",
		unit: "failures per assistant turn",
		denominator: "assistant turns",
		limitations: [
			"A session indexed before sync stored the stop reason reports its turn failures as absent, which means unknown. Reading absent as zero makes older months look healthier than newer ones.",
			"An abort is the operator stopping the agent. It is counted so that rates keep their full denominator, and the analyzer proposes nothing on it.",
		],
	},
	{
		id: "failure-modes.failure-class",
		name: "Failure class",
		definition: "The curated category of a failure, or unclassified when nothing in the catalogue matched.",
		measurement: "rule-based",
		unit: "failures per class",
		denominator: "failures",
		limitations: [
			"A hand-written catalogue matches the error text and, for some classes, the call itself. The share of unclassified failures measures the gaps in the catalogue.",
			"The catalogue grows, so a failure left unclassified in an old node may have a class in a newer one and class shares from different versions don't compare.",
			"The node keeps only the cause label and a digest of the error text, never the text.",
		],
	},
];
