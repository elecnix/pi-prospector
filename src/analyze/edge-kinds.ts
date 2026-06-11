/**
 * Typed edge graph constants and validation.
 *
 * The analysis graph expresses every relationship as an explicit typed edge.
 * There are no `parent_id` columns and no denormalised anchor columns on
 * analysis nodes — `analysis_edges` is the single source of truth for graph
 * relationships.
 *
 * Edge kinds
 *   anchors      node → (session | message)        where the analysis attaches
 *   consumes     node → analysis_node              inputs this node was built from
 *   uses_prompt  node → prompt_version             prompt that produced the node
 *   uses_config  node → config_version             config that produced the node
 *   produces     node → proposal                   proposal materialised from node
 *   revises      node → analysis_node              version lineage: this node is a
 *                                                   newer-version alternative of the
 *                                                   target node (same logical unit)
 */

export const REF_KINDS = {
	SESSION: "session",
	MESSAGE: "message",
	ANALYSIS_NODE: "analysis_node",
	PROMPT_VERSION: "prompt_version",
	CONFIG_VERSION: "config_version",
	PROPOSAL: "proposal",
} as const;

export type RefKind = (typeof REF_KINDS)[keyof typeof REF_KINDS];

export const EDGE_KINDS = {
	ANCHORS: "anchors",
	CONSUMES: "consumes",
	USES_PROMPT: "uses_prompt",
	USES_CONFIG: "uses_config",
	PRODUCES: "produces",
	REVISES: "revises",
} as const;

export type EdgeKind = (typeof EDGE_KINDS)[keyof typeof EDGE_KINDS];

const REF_KIND_SET = new Set<string>(Object.values(REF_KINDS));
const EDGE_KIND_SET = new Set<string>(Object.values(EDGE_KINDS));

/** Which ref kinds are valid targets for each edge kind. */
const VALID_TARGETS: Record<EdgeKind, ReadonlySet<RefKind>> = {
	[EDGE_KINDS.ANCHORS]: new Set([REF_KINDS.SESSION, REF_KINDS.MESSAGE]),
	[EDGE_KINDS.CONSUMES]: new Set([REF_KINDS.ANALYSIS_NODE]),
	[EDGE_KINDS.USES_PROMPT]: new Set([REF_KINDS.PROMPT_VERSION]),
	[EDGE_KINDS.USES_CONFIG]: new Set([REF_KINDS.CONFIG_VERSION]),
	[EDGE_KINDS.PRODUCES]: new Set([REF_KINDS.PROPOSAL]),
	[EDGE_KINDS.REVISES]: new Set([REF_KINDS.ANALYSIS_NODE]),
};

export function isRefKind(value: string): value is RefKind {
	return REF_KIND_SET.has(value);
}

export function isEdgeKind(value: string): value is EdgeKind {
	return EDGE_KIND_SET.has(value);
}

/**
 * Validate that `toRefKind` is an allowed target for `edgeKind`.
 * Throws with a descriptive message on violation.
 */
export function validateEdge(edgeKind: string, toRefKind: string): void {
	if (!isEdgeKind(edgeKind)) {
		throw new Error(`Invalid edge_kind: ${edgeKind}`);
	}
	if (!isRefKind(toRefKind)) {
		throw new Error(`Invalid to_ref_kind: ${toRefKind}`);
	}
	const allowed = VALID_TARGETS[edgeKind];
	if (!allowed.has(toRefKind)) {
		throw new Error(
			`Edge kind '${edgeKind}' cannot target ref kind '${toRefKind}'. ` +
			`Allowed: ${[...allowed].join(", ")}.`,
		);
	}
}
