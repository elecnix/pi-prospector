/**
 * Lineage by subject: which current nodes a new generation replaces.
 *
 * A node's **subject** is what it is about: its anchor, plus the subject an
 * analyzer names when it plans several units on one anchor (a term, a pull
 * request, a proposal). The subject stays put as the session grows. The source
 * set does not: a session-level unit that reads every message gets a new source
 * set with each new message, so the new unit is `missing`, and lineage keyed on
 * the source set never linked its node to the one it replaced. Both stayed
 * current, and every aggregate counted the session twice.
 *
 * The functions here are pure. The framework uses them to give a new node its
 * `revises` edges, and the lineage repair uses them to link the generations
 * written before this rule existed. Both apply one rule, so a repaired graph is
 * the graph the framework would have written.
 */

import { Type, type Static } from "typebox";
import type { AnalysisUnit } from "./types.js";

/** A current node of one analyzer, as lineage reads it. */
export const LineageHead = Type.Object({
	id: Type.String(),
	session_id: Type.String(),
	output_key: Type.String(),
	run_id: Type.Union([Type.String(), Type.Null()]),
	created_at: Type.String(),
	/** The node's first `anchors` target (lowest ordinal): the anchor of its unit. Null when it has none. */
	anchor_ref: Type.Union([Type.String(), Type.Null()]),
	/** Null when the analyzer declares no subject, so the content is not read. */
	content_json: Type.Union([Type.String(), Type.Null()]),
});
export type LineageHead = Static<typeof LineageHead>;

/** One `revises` edge the repair appends: `from` is a node id, `to` an output key. */
export const LineageEdge = Type.Object({ fromNodeId: Type.String(), toOutputKey: Type.String() });
export type LineageEdge = Static<typeof LineageEdge>;

export type SubjectOfNode = (content: Record<string, unknown>) => string | undefined;

/** The key a unit's lineage is grouped under: the anchor, then the subject when there is one. */
export function subjectKey(anchorRef: string, subject: string | undefined): string {
	return subject === undefined ? anchorRef : `${anchorRef}\u0000${subject}`;
}

export function unitSubjectKey(unit: AnalysisUnit): string {
	return subjectKey(unit.anchorRef, unit.subject);
}

/** The subject key of a stored node, or undefined when it has no anchor. */
export function headSubjectKey(head: LineageHead, subjectOfNode: SubjectOfNode | undefined): string | undefined {
	if (head.anchor_ref === null) return undefined;
	if (!subjectOfNode) return subjectKey(head.anchor_ref, undefined);
	let content: unknown;
	try {
		content = JSON.parse(head.content_json ?? "");
	} catch {
		return subjectKey(head.anchor_ref, undefined);
	}
	if (content === null || typeof content !== "object" || Array.isArray(content)) return subjectKey(head.anchor_ref, undefined);
	return subjectKey(head.anchor_ref, subjectOfNode(content as Record<string, unknown>));
}

/**
 * Group current nodes by subject. A group is left out when two of its nodes come
 * from one run: a run writes at most one node per subject, so such a group means
 * the analyzer plans several units on that anchor without naming their subjects,
 * and nothing says which old node a new one replaces.
 */
export function groupBySubject(
	heads: readonly LineageHead[],
	subjectOfNode: SubjectOfNode | undefined,
): Map<string, LineageHead[]> {
	const groups = new Map<string, LineageHead[]>();
	const ambiguous = new Set<string>();
	for (const head of heads) {
		const key = headSubjectKey(head, subjectOfNode);
		if (key === undefined) continue;
		const scoped = `${head.session_id}\u0001${key}`;
		const group = groups.get(scoped) ?? [];
		if (head.run_id !== null && group.some((h) => h.run_id === head.run_id)) ambiguous.add(scoped);
		group.push(head);
		groups.set(scoped, group);
	}
	for (const key of ambiguous) groups.delete(key);
	return groups;
}

/** The scoped key {@link groupBySubject} files a unit's subject under. */
export function scopedSubjectKey(sessionId: string, unit: AnalysisUnit): string {
	return `${sessionId}\u0001${unitSubjectKey(unit)}`;
}

/**
 * The subject keys a plan names more than once. Units on such a key share an
 * anchor with no subject to tell them apart, so they keep the lineage of their
 * source set only.
 */
export function sharedSubjectKeys(units: readonly AnalysisUnit[]): Set<string> {
	const seen = new Set<string>();
	const shared = new Set<string>();
	for (const unit of units) {
		const key = unitSubjectKey(unit);
		if (seen.has(key)) shared.add(key);
		seen.add(key);
	}
	return shared;
}

/** Whether `a` was written after `b`, the id breaking a tie. */
function isNewer(a: LineageHead, b: LineageHead): boolean {
	if (a.created_at !== b.created_at) return a.created_at > b.created_at;
	return a.id > b.id;
}

/**
 * The edges that leave one current node per subject: in every group with more
 * than one node, the newest revises each of the others. Running it again on the
 * graph it repaired finds one node per group and returns nothing.
 */
export function repairEdges(heads: readonly LineageHead[], subjectOfNode: SubjectOfNode | undefined): LineageEdge[] {
	const edges: LineageEdge[] = [];
	for (const group of groupBySubject(heads, subjectOfNode).values()) {
		if (group.length < 2) continue;
		let newest = group[0]!;
		for (const head of group) if (isNewer(head, newest)) newest = head;
		for (const head of group) {
			if (head !== newest) edges.push({ fromNodeId: newest.id, toOutputKey: head.output_key });
		}
	}
	return edges;
}
