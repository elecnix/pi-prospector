/**
 * Unit tests for the friction-accumulation accumulation math and decline
 * heuristic. Pure functions only — no database, no framework, no mocks.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	computeContributions,
	computeWindowRates,
	evaluateDecline,
	type CoreTurnSignal,
	type TrajectorySignalRef,
} from "../../src/analyze/analyzers/friction-accumulation/detect.js";
import { DEFAULT_FRICTION_ACCUMULATION_CONFIG } from "../../src/analyze/analyzers/friction-accumulation/config.js";

const cfg = { ...DEFAULT_FRICTION_ACCUMULATION_CONFIG };

function turns(scores: number[]): CoreTurnSignal[] {
	return scores.map((s, i) => ({
		pair_index: i,
		user_message_id: `u${i}`,
		friction_score: s,
	}));
}

/** Full contribution rows from plain values, for window-rate math. */
function contributionsOf(values: number[]) {
	return values.map((v, i) => ({
		pair_index: i,
		user_message_id: `u${i}`,
		core_score: v,
		frustration_weight: 0,
		trajectory_weight: 0,
		contribution: v,
	}));
}

describe("computeContributions", () => {
	it("accumulates core scores into per-turn contributions in turn order", () => {
		const out = computeContributions(turns([0.2, 0, 0.9]), new Map(), [], new Map(), cfg);
		assert.deepEqual(
			out.map((c) => [c.pair_index, c.contribution]),
			[
				[0, 0.2],
				[1, 0],
				[2, 0.9],
			],
		);
		assert.equal(out[0]!.core_score, 0.2);
	});

	it("sorts out-of-order input by pair index", () => {
		const shuffled = [...turns([0.1, 0.3, 0.5])].reverse();
		const out = computeContributions(shuffled, new Map(), [], new Map(), cfg);
		assert.deepEqual(out.map((c) => c.pair_index), [0, 1, 2]);
		assert.deepEqual(out.map((c) => c.contribution), [0.1, 0.3, 0.5]);
	});

	it("sums frustration hit weights per turn and caps them", () => {
		const weights = new Map([
			["u0", 0.3 + 0.3], // two hits, above the default cap of 0.5
			["u1", 0.2], // below the cap
		]);
		const out = computeContributions(turns([0, 0]), weights, [], new Map(), cfg);
		assert.equal(out[0]!.frustration_weight, cfg.frustrationWeightCap);
		assert.equal(out[1]!.frustration_weight, 0.2);
	});

	it("attributes a trajectory signal once, to the turn holding its last message", () => {
		const signals: TrajectorySignalRef[] = [
			{ pattern: "stuck-loop", messageIds: ["a1", "a2", "a3"] }, // spans turns 0–2
		];
		// Turn boundaries by user_message_id; assistant/tool ids map to their turn.
		const msgMap = new Map([
			["a1", "u0"],
			["a2", "u1"],
			["a3", "u2"],
			["u0", "u0"],
			["u1", "u1"],
			["u2", "u2"],
		]);
		const out = computeContributions(turns([0, 0, 0]), new Map(), signals, msgMap, cfg);
		assert.equal(out[0]!.trajectory_weight, 0);
		assert.equal(out[1]!.trajectory_weight, 0);
		assert.equal(out[2]!.trajectory_weight, cfg.trajectorySignalWeight, "the culmination turn carries the weight");
	});

	it("clamps a turn's total contribution to 1", () => {
		const out = computeContributions(turns([0.9]), new Map([["u0", 0.5]]), [{ pattern: "stuck-loop", messageIds: ["u0"] }], new Map([["u0", "u0"]]), cfg);
		assert.equal(out[0]!.contribution, 1);
	});
});

describe("computeWindowRates", () => {
	it("means each complete window and drops the trailing stub", () => {
		const rates = computeWindowRates(contributionsOf([0, 0.2, 0.4, 0.6, 0.8]), 2);
		assert.deepEqual(rates.map((r) => r.mean_rate), [0.1, 0.5], "the final lone turn forms no complete window");
		assert.equal(rates[0]!.start_pair_index, 0);
		assert.equal(rates[0]!.end_pair_index, 1);

		const exact = computeWindowRates(contributionsOf([0, 0.2, 0.4, 0.6, 0.8, 1]), 2);
		assert.deepEqual(exact.map((r) => r.mean_rate), [0.1, 0.5, 0.9]);
	});

	it("returns no windows when fewer turns exist than one window", () => {
		assert.deepEqual(computeWindowRates(contributionsOf([0.5]), 4), []);
	});
});

describe("evaluateDecline", () => {
	it("fires on a rising-friction session past the recurrence gate", () => {
		// First window clean, second window heavy — the gradual-decline shape no
		// per-turn threshold sees.
		const contributions = computeContributions(turns([0, 0, 0, 0, 0.8, 0.8, 0.8, 0.8]), new Map(), [], new Map(), cfg);
		const verdict = evaluateDecline(contributions, computeWindowRates(contributions, cfg.windowSize), cfg);
		assert.equal(verdict.decline_detected, true);
		assert.equal(verdict.first_window_rate, 0);
		assert.ok(Math.abs(verdict.last_window_rate - 0.8) < 1e-12);
		assert.ok(verdict.decline_delta >= cfg.declineThreshold);
	});

	it("stays quiet on a steady session — even a steadily bad one", () => {
		const contributions = computeContributions(turns(Array(8).fill(0.7)), new Map(), [], new Map(), cfg);
		const verdict = evaluateDecline(contributions, computeWindowRates(contributions, cfg.windowSize), cfg);
		assert.equal(verdict.decline_detected, false, "flat high friction is not a decline");
		assert.equal(verdict.decline_delta, 0);
	});

	it("stays quiet on a falling-friction session", () => {
		const contributions = computeContributions(turns([0.9, 0.9, 0.9, 0.9, 0, 0, 0, 0]), new Map(), [], new Map(), cfg);
		const verdict = evaluateDecline(contributions, computeWindowRates(contributions, cfg.windowSize), cfg);
		assert.equal(verdict.decline_detected, false, "improving sessions are the opposite of declining");
	});

	it("never flags a session too short to hold two disjoint windows", () => {
		const contributions = computeContributions(turns([0, 0, 0.9]), new Map(), [], new Map(), cfg);
		const verdict = evaluateDecline(contributions, computeWindowRates(contributions, cfg.windowSize), cfg);
		assert.equal(verdict.decline_detected, false);
	});

	it("honours minTurnsForDecline even when both windows fit", () => {
		const tightCfg = { ...cfg, windowSize: 2, minTurnsForDecline: 8 };
		const contributions = computeContributions(turns([0, 0, 0.9, 0.9]), new Map(), [], new Map(), tightCfg);
		const verdict = evaluateDecline(contributions, computeWindowRates(contributions, tightCfg.windowSize), tightCfg);
		assert.equal(verdict.decline_detected, false, "4 turns < recurrence gate of 8");
	});
});
