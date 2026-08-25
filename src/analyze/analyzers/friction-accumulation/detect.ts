/**
 * Deterministic friction accumulation and decline detection (issue #101).
 *
 * Pure functions over per-turn friction signals — no LLM, no database. The
 * heuristic is deliberately simple and documented here in full:
 *
 *   1. **Contribution** — each turn carries one number on the 0–1 scale:
 *        contribution = clamp01(core_score + capped_frustration + trajectory)
 *      where `core_score` is the turn's deterministic friction score
 *      (turn-pair-core), `capped_frustration` is the sum of the turn's learned
 *      lexicon / paralinguistic hit weights clamped to `frustrationWeightCap`,
 *      and `trajectory` is `trajectorySignalWeight` when a tool-trajectory
 *      signal culminates in this turn.
 *
 *   2. **Accumulation** — contributions are summed over the session's turn
 *      sequence into `accumulated_friction`; the running shape is what makes a
 *      gradual decline legible: no single turn needs to trip any threshold.
 *
 *   3. **Decline** — the mean contribution of the FIRST `windowSize` turns is
 *      compared with that of the LAST `windowSize` turns (both complete). When
 *      the last window's rate exceeds the first's by at least `declineThreshold`
 *      and there are at least `minTurnsForDecline` turns (and always at least
 *      two disjoint windows), the session is flagged declining. A session whose
 *      friction is steady — even steadily bad — never flags; the signal is the
 *      *slope*, not the level.
 *
 * Trajectory attribution: each signal counts once, attributed to the turn
 * containing its LAST participating message id (where the pattern peaked).
 * Attributing it to every turn it spans would double-count one loop across the
 * accumulation and manufacture decline out of a single mid-session loop.
 */

import { Type, type Static } from "typebox";
import type { FrictionAccumulationConfig } from "./config.js";

/** One turn's raw deterministic signals, as read from upstream nodes. */
export interface CoreTurnSignal {
	pair_index: number;
	user_message_id: string;
	friction_score: number;
}

/** A tool-trajectory signal reference: pattern plus participating message ids. */
export interface TrajectorySignalRef {
	pattern: string;
	messageIds: string[];
}

export const TurnContribution = Type.Object({
	pair_index: Type.Number(),
	user_message_id: Type.String(),
	/** The turn's turn-pair-core friction score. */
	core_score: Type.Number(),
	/** Summed lexicon/marker hit weights after the cap was applied. */
	frustration_weight: Type.Number(),
	/** Trajectory weight carried by this turn (0 or one signal culmination). */
	trajectory_weight: Type.Number(),
	/** The turn's total contribution to the accumulation, clamped to [0, 1]. */
	contribution: Type.Number(),
});
export type TurnContribution = Static<typeof TurnContribution>;

export const WindowRate = Type.Object({
	window_index: Type.Number(),
	start_pair_index: Type.Number(),
	end_pair_index: Type.Number(),
	/** Mean per-turn contribution inside this window. */
	mean_rate: Type.Number(),
});
export type WindowRate = Static<typeof WindowRate>;

export const DeclineVerdict = Type.Object({
	first_window_rate: Type.Number(),
	last_window_rate: Type.Number(),
	decline_delta: Type.Number(),
	decline_detected: Type.Boolean(),
});
export type DeclineVerdict = Static<typeof DeclineVerdict>;

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

/**
 * Per-turn contributions over the ordered turn sequence. Turns are sorted by
 * pair index; every turn present in `coreTurns` gets exactly one entry.
 */
export function computeContributions(
	coreTurns: readonly CoreTurnSignal[],
	frustrationWeightByTurnId: ReadonlyMap<string, number>,
	trajectorySignals: readonly TrajectorySignalRef[],
	messageToUserMessageId: ReadonlyMap<string, string>,
	config: FrictionAccumulationConfig,
): TurnContribution[] {
	// Each trajectory signal attributes its weight once: to the turn holding its
	// last participating message id (the culmination). Signals with no
	// participating message in any turn contribute nothing rather than guessing.
	const trajectoryByTurnId = new Map<string, number>();
	for (const signal of [...trajectorySignals].sort((a, b) => a.pattern.localeCompare(b.pattern))) {
		for (let i = signal.messageIds.length - 1; i >= 0; i--) {
			const turnId = messageToUserMessageId.get(signal.messageIds[i]!);
			if (turnId) {
				trajectoryByTurnId.set(turnId, config.trajectorySignalWeight);
				break;
			}
		}
	}

	return [...coreTurns]
		.sort((a, b) => a.pair_index - b.pair_index)
		.map((turn) => {
			const rawFrustration = frustrationWeightByTurnId.get(turn.user_message_id) ?? 0;
			const frustrationWeight = Math.min(config.frustrationWeightCap, rawFrustration);
			const trajectoryWeight = trajectoryByTurnId.get(turn.user_message_id) ?? 0;
			return {
				pair_index: turn.pair_index,
				user_message_id: turn.user_message_id,
				core_score: turn.friction_score,
				frustration_weight: frustrationWeight,
				trajectory_weight: trajectoryWeight,
				contribution: clamp01(turn.friction_score + frustrationWeight + trajectoryWeight),
			};
		});
}

/**
 * Mean contribution rates over COMPLETE windows of `windowSize` consecutive
 * turns. A trailing partial window is excluded: comparing a four-turn window
 * against a one-turn stub would let a single noisy final turn decide.
 */
export function computeWindowRates(
	contributions: readonly TurnContribution[],
	windowSize: number,
): WindowRate[] {
	const rates: WindowRate[] = [];
	for (let start = 0; start + windowSize <= contributions.length; start += windowSize) {
		let sum = 0;
		for (let i = start; i < start + windowSize; i++) sum += contributions[i]!.contribution;
		rates.push({
			window_index: rates.length,
			start_pair_index: contributions[start]!.pair_index,
			end_pair_index: contributions[start + windowSize - 1]!.pair_index,
			mean_rate: sum / windowSize,
		});
	}
	return rates;
}

/**
 * The decline verdict: last complete window's mean rate vs first's. Fires only
 * when both windows exist and the recurrence gate (`minTurnsForDecline`, and
 * always at least `2 * windowSize`) is met — a slope needs room to be a slope.
 */
export function evaluateDecline(
	contributions: readonly TurnContribution[],
	rates: readonly WindowRate[],
	config: FrictionAccumulationConfig,
): DeclineVerdict {
	const first = rates[0];
	const last = rates[rates.length - 1];
	if (!first || !last || rates.length < 2) {
		return {
			first_window_rate: first?.mean_rate ?? 0,
			last_window_rate: last?.mean_rate ?? first?.mean_rate ?? 0,
			decline_delta: 0,
			decline_detected: false,
		};
	}
	const delta = last.mean_rate - first.mean_rate;
	const minTurns = Math.max(config.minTurnsForDecline, 2 * config.windowSize);
	return {
		first_window_rate: first.mean_rate,
		last_window_rate: last.mean_rate,
		decline_delta: delta,
		decline_detected: contributions.length >= minTurns && delta >= config.declineThreshold,
	};
}
