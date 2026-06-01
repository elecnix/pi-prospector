/**
 * Edge kind constants and validation
 * Based on analyzer-design-c.md specification
 */

// ── Edge Kind Constants ──

export const EDGE_KINDS = {
	ANCHORS: "anchors",
	CONSUMES: "consumes",
	REFINES: "refines",
	USES_PROMPT: "uses_prompt",
	USES_CONFIG: "uses_config",
	PRODUCES: "produces",
} as const;

export type EdgeKind = typeof EDGE_KINDS[keyof typeof EDGE_KINDS];

// ── Valid Target Kinds per Edge Kind ──

export const VALID_TARGET_KINDS: Record<string, string[]> = {
	anchors: ["message", "session"],
	consumes: ["message", "analysis_node", "session"],
	refines: ["analysis_node"],
	uses_prompt: ["prompt_version"],
	uses_config: ["config_version"],
	produces: [], // produces targets proposals derived from content
};

// ── Validation Functions ──

export function validateEdgeKind(kind: string): EdgeKind {
	if (!Object.values(EDGE_KINDS).includes(kind as EdgeKind)) {
		throw new Error(`Invalid edge kind: ${kind}`);
	}
	return kind as EdgeKind;
}

export function validateTargetKind(edgeKind: EdgeKind, targetKind: string): boolean {
	const validKinds = VALID_TARGET_KINDS[edgeKind];
	return validKinds?.includes(targetKind) ?? false;
}