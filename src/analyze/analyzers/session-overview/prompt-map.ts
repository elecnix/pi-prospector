/**
 * Map-phase prompt: summarise one digest segment of a large session.
 */

import { shortHash } from "../../input-hash.js";
import { Type } from "typebox";

export const MAP_PROMPT = `You summarise one segment of a coding-agent session's signals — both friction
and positive (things that went well). Return your summary by calling the
\`submit_segment_summary\` tool. Do NOT reply with prose. The tool takes:
{
  "segment_summary": "2-4 sentences on what happened, including any friction and any positive patterns",
  "notable_points": ["short bullet", "..."]
}
Note any clean recoveries (correction followed by smooth work), low friction, or
task completions without correction. Be concise and factual. Do not invent details
beyond the signals provided.

Always respond by calling the submit_segment_summary tool — never answer in prose.`;

export const MAP_PROMPT_HASH = shortHash(MAP_PROMPT);

/** Forced-tool-call schema for the map phase (reliable structured output). */
export const MAP_TOOL = {
	name: "submit_segment_summary",
	description: "Submit the structured summary of one session segment.",
	parameters: Type.Object({
		segment_summary: Type.String({
			description: "2-4 sentences on what happened, including any friction and any positive patterns",
		}),
		notable_points: Type.Array(Type.String(), { description: "short factual bullets" }),
	}),
};

export interface MapSummary {
	segment_summary: string;
	notable_points: string[];
}

export function buildMapPrompt(segmentText: string): string {
	return `SESSION SEGMENT SIGNALS:\n${segmentText}`;
}

export function parseMapResponse(text: string, extractJsonObject: (t: string) => Record<string, unknown>): MapSummary {
	return parseMapObject(extractJsonObject(text));
}

/** Normalise an already-parsed map object (e.g. forced-tool-call arguments). */
export function parseMapObject(obj: Record<string, unknown>): MapSummary {
	const notable = Array.isArray(obj["notable_points"])
		? (obj["notable_points"] as unknown[]).filter((x): x is string => typeof x === "string")
		: [];
	return {
		segment_summary: typeof obj["segment_summary"] === "string" ? (obj["segment_summary"] as string) : "",
		notable_points: notable,
	};
}
