/**
 * Display-time grouping of proposals under the higher-level proposal that
 * generalises them (issue #107).
 *
 * No new analysis and nothing suppressed: this is purely a presentation step
 * over the finished graph, implementing the policy DESIGN.md already states —
 * "deduplication is a downstream concern handled at display time, not at
 * synthesis time". The graph carries what is needed as typed edges:
 *
 *   - `consumes`  node → analysis_node  which nodes a summary was built from
 *   - `produces`  node → proposal       which proposals a node yielded
 *
 * Walking those backwards from a proposal P whose source node S consumed an
 * upstream node U gives P's *supporting* proposals: the ones U produced. A
 * session-level synthesis usually consumes per-turn nodes; when both levels
 * materialised proposals, the specific turn-level findings are instances of
 * the general one, so they nest beneath it instead of arriving as unrelated
 * flat items.
 *
 * Display policy (documented decisions, deliberately cheap and reversible):
 *
 *   - **Nesting** — a proposal whose producing node was consumed by another
 *     listed proposal's source node renders indented beneath that parent
 *     rather than at top level. Nothing is removed from the view; the list
 *     just stops being flat. Grouping operates within the current result set:
 *     a support edge pointing at a proposal outside the active filters is not
 *     displayed (it belongs to another view), never silently deleted.
 *   - **Partial support** — a generaliser usually covers more evidence than
 *     its nested instances (only some of its consumed nodes produced listed
 *     proposals). That is fine: nesting records provenance, not full coverage.
 *     Whatever support edges resolve within the listing are shown; the rest of
 *     the parent's evidence stays visible in `prospect show <id>`.
 *   - **Multi-parent** — one upstream node can feed several generalisers, so a
 *     child may resolve under more than one parent. It is shown under *each*
 *     of them: existence stays additive (the same rule the lexicon applies to
 *     overlapping hits). Hiding it under only the first parent would leave the
 *     second reader without its instance evidence. The cost is that such a
 *     child appears twice — accepted, documented trade-off.
 *   - **Depth** — one hop only (direct consumption). Deeper chains would nest
 *     whole subtrees under each ancestor; today's shipped analyzers relate at
 *     exactly two altitudes (session-level synthesis over per-turn signals),
 *     so the extra generality buys nothing yet.
 */

import type { AsyncDatabase } from "../db/async-db.js";
import { getNodeByOutputKey, getEdgesFrom } from "../db/analysis-queries.js";
import { EDGE_KINDS, REF_KINDS } from "../analyze/edge-kinds.js";
import type { Proposal } from "../types.js";

/**
 * One entry of the grouped listing: a proposal plus the supporting proposals
 * nested beneath it (empty for a leaf). Plain data shape mirroring `Proposal`
 * itself; the JSON surface serialises it by spreading the proposal row and
 * adding `supports` only when non-empty, so ungrouped rows keep their shape.
 */
export interface GroupedProposal {
	proposal: Proposal;
	supports: GroupedProposal[];
}

/** parentId → ids of the proposals that support it (already filtered to the listing). */
export type SupportMap = Map<string, string[]>;

/**
 * Walk `consumes`/`produces` backwards from every proposal with a recorded
 * source node, returning the support relationships among `proposals`.
 *
 * For a proposal P anchored at source node S: S's `consumes` edges target the
 * upstream node's content-addressed `output_key`; each resolved upstream node's
 * `produces` edges yield child proposal ids. Only children present in the
 * listing survive (see the display policy above).
 */
export async function collectSupportMap(db: AsyncDatabase, proposals: readonly Proposal[]): Promise<SupportMap> {
	const listed = new Set(proposals.map((p) => p.id));
	const map: SupportMap = new Map();
	// Several proposals can share one source node (e.g. after re-materialisation);
	// walk each distinct source node once and attach its children to all of them.
	const bySource = new Map<string, string[]>();
	for (const p of proposals) {
		if (!p.source_node_id) continue;
		const owners = bySource.get(p.source_node_id);
		if (owners) owners.push(p.id);
		else bySource.set(p.source_node_id, [p.id]);
	}

	for (const [sourceId, ownerIds] of bySource) {
		const children: string[] = [];
		const consumed = (await getEdgesFrom(db, sourceId)).filter(
			(e) => e.edge_kind === EDGE_KINDS.CONSUMES && e.to_ref_kind === REF_KINDS.ANALYSIS_NODE,
		);
		for (const edge of consumed) {
			const upstream = await getNodeByOutputKey(db, edge.to_ref_id);
			if (!upstream) continue;
			const produced = (await getEdgesFrom(db, upstream.id)).filter(
				(e) => e.edge_kind === EDGE_KINDS.PRODUCES && e.to_ref_kind === REF_KINDS.PROPOSAL,
			);
			for (const edge of produced) {
				if (!listed.has(edge.to_ref_id)) continue;
				if (!children.includes(edge.to_ref_id)) children.push(edge.to_ref_id);
			}
		}
		if (children.length > 0) for (const ownerId of ownerIds) map.set(ownerId, children);
	}
	return map;
}

/**
 * Build the nested listing from ranked proposals and a support map.
 * Pure over its arguments. Proposals that appear as a child of some other
 * listed proposal become nested entries; the rest are roots. Roots keep the
 * caller's order; a parent's supports follow the same ranking order, so the
 * tree re-uses the trust-tier ordering everywhere.
 */
export function nestProposals(ranked: readonly Proposal[], supportOf: SupportMap): GroupedProposal[] {
	const byId = new Map(ranked.map((p) => [p.id, p]));
	const rank = new Map(ranked.map((p, i) => [p.id, i] as const));
	// Invert to parents-per-child, restricted to the listing.
	const parentsOf = new Map<string, string[]>();
	for (const [parentId, childIds] of supportOf) {
		if (!byId.has(parentId)) continue;
		for (const childId of childIds) {
			if (!byId.has(childId)) continue;
			const parents = parentsOf.get(childId);
			if (parents) parents.push(parentId);
			else parentsOf.set(childId, [parentId]);
		}
	}

	function build(id: string, seen: Set<string>): GroupedProposal {
		const proposal = byId.get(id)!;
		seen.add(id);
		const childIds = (supportOf.get(id) ?? [])
			.filter((cid) => byId.has(cid))
			// Defensive cycle guard: the consumes/produces walk cannot cycle on a
			// DAG, but a hand-edited or future graph must not hang the renderer.
			.filter((cid) => !seen.has(cid))
			.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
		const supports = childIds.map((cid) => build(cid, new Set(seen)));
		return { proposal, supports };
	}

	const roots = ranked.filter((p) => !parentsOf.has(p.id)).map((p) => build(p.id, new Set()));
	return roots;
}

/**
 * Serialise a grouped entry for machine-readable output: the full proposal row
 * spread verbatim, plus `supports` **only when non-empty**, so a non-grouped
 * proposal's JSON keeps exactly the shape it had before this feature existed.
 */
export function serialiseGrouped(entry: GroupedProposal): Record<string, unknown> {
	const json: Record<string, unknown> = { ...entry.proposal };
	if (entry.supports.length > 0) json["supports"] = entry.supports.map(serialiseGrouped);
	return json;
}

function indentBlock(block: string, pad: string): string {
	return block.split("\n").map((l) => `${pad}${l}`).join("\n");
}

/**
 * Render a grouped tree as human-readable text. Each entry is formatted by
 * `formatEntry` (async: decisions/validation lines need the DB); direct
 * supports render beneath their parent, indented and marked with `↳`, so the
 * "pattern with its instances" reads top-down.
 */
export async function renderGroupedProposals(
	entries: readonly GroupedProposal[],
	formatEntry: (p: Proposal) => Promise<string>,
): Promise<string[]> {
	const blocks: string[] = [];
	for (const entry of entries) {
		const head = await formatEntry(entry.proposal);
		if (entry.supports.length === 0) {
			blocks.push(head);
		} else {
			const children = await renderGroupedProposals(entry.supports, formatEntry);
			blocks.push(`${head}\n${indentBlock(children.join("\n"), "    ↳ ")}`);
		}
	}
	return blocks;
}
