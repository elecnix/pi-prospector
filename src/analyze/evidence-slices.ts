/**
 * Event-centered evidence slices (issue #118, after LivePlan §II-B).
 *
 * A *trigger point* is a deterministic detection event in the session — a
 * trajectory signal, a high-signal friction flag, a learned-lexicon
 * frustration hit, or (when the phase-trajectory analyzer has run) a phase
 * transition. Every such event names the messages it participated in, and
 * those message ids map onto turn-pair indexes. When an LLM consumer needs
 * evidence around one event, the relevant context is not a fixed-position
 * window but *the turns since the previous trigger* — forward slicing from
 * the last detection event to the current turn.
 *
 * Pure functions only: no database, no LLM. Both consumers (session-overview's
 * digest and turn-pair-llm's classify prompt) call these so they cannot
 * disagree about where a slice starts or how long it may grow.
 *
 * This is deliberately NOT backward slicing from an outcome: the system labels
 * no outcomes (#102). Slicing runs forward from the trigger itself — the cheap,
 * deterministic approximation that keeps prompts bounded AND relevant.
 */

import type { TurnPair } from "./analyzers/turn-pair-core/build.js";

/**
 * Hard ceiling on the length of one evidence slice, in turns. A session whose
 * triggers are sparse must still render a bounded slice — a pathological,
 * trigger-free session would otherwise pull its whole history into every
 * prompt. Deterministic constant (not config) so slice boundaries are part of
 * the shipped recipe identity, like MAX_TOOL_EVIDENCE_PER_TURN.
 */
export const EVIDENCE_SLICE_CEILING = 12;

/**
 * Map every message id of a session to the index of the turn pair that
 * contains it (turn-starting ids and assistant/toolResult ids alike). Signals
 * carry raw message ids; consumers think in pair indexes.
 */
export function buildMessageIdToPairIndex(pairs: readonly TurnPair[]): Map<string, number> {
	const map = new Map<string, number>();
	for (const p of pairs) {
		map.set(p.userMessageId, p.index);
		for (const id of p.messageIds) map.set(id, p.index);
	}
	return map;
}

/**
 * The pair index where an event at `currentIndex` should start reading back
 * from: the most recent trigger strictly before `currentIndex`, clamped to at
 * most `ceiling - 1` turns behind the event. With no previous trigger at all,
 * the ceiling alone bounds the window. Triggers at the current index do NOT
 * bound their own slice — two signals firing on the same turn share one slice
 * start, and a signal never truncates its own evidence to zero.
 *
 * @param triggerIndexes ascending, de-duplicated pair indexes of every
 *   detection event in the session (see collectTriggerPairIndexes).
 */
export function sliceStartIndex(
	triggerIndexes: readonly number[],
	currentIndex: number,
	ceiling: number = EVIDENCE_SLICE_CEILING,
): number {
	const boundedStart = Math.max(0, currentIndex - Math.max(1, ceiling) + 1);
	let prev = -1;
	for (const t of triggerIndexes) {
		if (t < currentIndex) prev = t;
		else break;
	}
	return prev < 0 ? boundedStart : Math.max(prev, boundedStart);
}

/**
 * Collect the sorted, de-duplicated set of trigger pair indexes from groups of
 * message ids. Each group is one signal family's participating-message-id list
 * (trajectory signal messageIds, frustration hit anchors, high-signal anchors,
 * phase-transition anchors…); ids that map to no known pair are ignored — a
 * signal referencing a message outside any turn cannot anchor a slice.
 */
export function collectTriggerPairIndexes(
	messageIdToPairIndex: ReadonlyMap<string, number>,
	idGroups: readonly (readonly string[])[],
): number[] {
	const set = new Set<number>();
	for (const group of idGroups) {
		for (const id of group) {
			const idx = messageIdToPairIndex.get(id);
			if (idx !== undefined) set.add(idx);
		}
	}
	return [...set].sort((a, b) => a - b);
}
