import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_CALL_ID } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "uncompleted-leads.lead",
		name: "Surfaced leads",
		definition: "Per session, the number of leads that tool output surfaced (a file path, a URL, a suggested command), split into those a later tool call pursued and those it did not.",
		measurement: "rule-based",
		unit: "leads per session",
		denominator: "none",
		values: [
			{ value: "path", meaning: "A file path in a grep hit, an error payload or test output." },
			{ value: "url", meaning: "A URL printed in a result." },
			{ value: "command", meaning: "A suggested command, from a small allowlist of command heads." },
		],
		limitations: [
			"Extraction goes by shape, so a path the output mentions in passing is a lead.",
			"A lead is complete when a later call within the configured window matches it literally, so a lead pursued in another way or after the window reads as uncompleted.",
			"The stored list is capped, and the node stores how many leads were truncated.",
			LIMIT_CALL_ID,
		],
		seriesBreaks: [
			{
				version: "1.1",
				effect: "The action stream pairs results with id-less stored calls, so those sessions yield the leads their tool results held. Earlier nodes show none.",
				repair: "prospect analyze --analyzer uncompleted-leads --revise minor",
			},
		],
	},
	{
		id: "uncompleted-leads.uncompleted-by-type",
		name: "Uncompleted leads by class",
		definition: "The number of leads left unpursued, per lead class.",
		measurement: "rule-based",
		unit: "leads per class",
		denominator: "surfaced leads of the class",
		limitations: [
			"A proposal needs the same class to recur across a session, so one stray lead is a measurement and not a finding.",
			"The class list is closed: path, url and command.",
			LIMIT_CALL_ID,
		],
		seriesBreaks: [
			{
				version: "1.1",
				effect: "The action stream pairs results with id-less stored calls, so those sessions yield the leads their tool results held, and the per-class counts rise from zero.",
				repair: "prospect analyze --analyzer uncompleted-leads --revise minor",
			},
		],
	},
];
