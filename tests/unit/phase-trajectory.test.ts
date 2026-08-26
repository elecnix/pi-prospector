/**
 * Unit tests for phase-trajectory classification and plan-compliance signals
 * (issue #115). Pure functions over hand-written synthetic message shapes —
 * no database, no LLM, no real session data.
 *
 * Every signal has both a purpose-built firing sequence and a compliant twin
 * that must stay quiet, because a detector that cannot stay silent is noise,
 * not analysis.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	classifyTurnPhases,
	detectPhaseSignals,
	type ClassifiedTurn,
	type TurnSourceMessage,
} from "../../src/analyze/analyzers/phase-trajectory/classify.js";
import {
	DEFAULT_PHASE_TRAJECTORY_CONFIG,
	type PhaseTrajectoryConfig,
} from "../../src/analyze/analyzers/phase-trajectory/config.js";

const CFG = DEFAULT_PHASE_TRAJECTORY_CONFIG;

let seq = 0;

/** A bash call inside its own assistant message. */
function bash(command: string): TurnSourceMessage {
	return {
		id: `a${seq++}`,
		role: "assistant",
		tool_calls: JSON.stringify([{ name: "bash", arguments: { command } }]),
	};
}

/** A structured tool call inside its own assistant message. */
function tool(name: string, args: Record<string, unknown>): TurnSourceMessage {
	return {
		id: `a${seq++}`,
		role: "assistant",
		tool_calls: JSON.stringify([{ name, arguments: args }]),
	};
}

/** One turn: a user boundary plus the assistant calls made in response. */
function turn(calls: TurnSourceMessage[]): TurnSourceMessage[] {
	return [{ id: `u${seq++}`, role: "user", tool_calls: null }, ...calls];
}

function classify(turns: TurnSourceMessage[][], cfg: PhaseTrajectoryConfig = CFG): ClassifiedTurn[] {
	return classifyTurnPhases(
		turns.flat(),
		cfg,
	);
}

function phasesOf(entries: ClassifiedTurn[]): string[] {
	return entries.map((e) => e.phase);
}

function kindsOf(signals: ReturnType<typeof detectPhaseSignals>): string[] {
	return signals.map((s) => s.signal);
}

// ─────────────────────────── per-turn classification ───────────────────────────

describe("classifyTurnPhases", () => {
	it("classifies read-only commands and tools as navigate", () => {
		const entries = classify([turn([bash("git status")]), turn([tool("read", { file_path: "/src/x.ts" })]), turn([bash("gh pr view 29")])]);
		assert.deepEqual(phasesOf(entries), ["navigate", "navigate", "navigate"]);
	});

	it("classifies mutating commands and edit/write tools as patch", () => {
		const entries = classify([
			turn([bash("git add -A"), bash("git commit -m fix")]),
			turn([tool("edit", { file_path: "/src/x.ts" })]),
			turn([tool("write", { file_path: "/src/y.ts" })]),
		]);
		assert.deepEqual(phasesOf(entries), ["patch", "patch", "patch"]);
	});

	it("classifies the SAME test command as reproduce before any patch and validate after one — the ordering dependency IS the signal", () => {
		const before = classify([turn([bash("npm test")])]);
		const after = classify([turn([tool("edit", { file_path: "/src/x.ts" })]), turn([bash("npm test")])]);
		assert.equal(before[0]?.phase, "reproduce");
		assert.deepEqual(phasesOf(after), ["patch", "validate"]);

		// And pytest behaves identically to npm test.
		const pytestAfter = classify([turn([tool("write", { file_path: "/src/y.py" })]), turn([bash("pytest -q")])]);
		assert.deepEqual(phasesOf(pytestAfter), ["patch", "validate"]);
	});

	it("counts lint/typecheck/CI-status checks as validate only after a patch; before one they are navigation", () => {
		const before = classify([turn([bash("eslint .")]), turn([bash("tsc --noEmit")]), turn([bash("gh run list --limit 1")])]);
		assert.deepEqual(phasesOf(before), ["navigate", "navigate", "navigate"]);
		const after = classify([turn([tool("edit", { file_path: "/f.ts" })]), turn([bash("eslint .")]), turn([bash("gh run list --limit 1")])]);
		assert.deepEqual(phasesOf(after), ["patch", "validate", "validate"]);
	});

	it("classifies turns without tool calls, and unknown structured tools, as other", () => {
		const entries = classify([turn([]), turn([tool("task", { prompt: "delegate something" })])]);
		assert.deepEqual(phasesOf(entries), ["other", "other"]);
	});

	it("a turn containing both navigation and a mutation is patch, and flips the session into post-patch state", () => {
		const entries = classify([
			turn([bash("grep -rn TODO /src"), tool("edit", { file_path: "/src/x.ts" })]),
			turn([bash("npm test")]),
		]);
		assert.deepEqual(phasesOf(entries), ["patch", "validate"]);
	});
});

// ─────────────────────────── signals ───────────────────────────

describe("detectPhaseSignals — compliant sequences stay quiet", () => {
	it("the full canonical cycle navigate→reproduce→patch→validate produces zero signals", () => {
		const entries = classify([
			turn([bash("git status")]),
			turn([bash("npm test")]),
			turn([bash("git add -A")]),
			turn([bash("npm test")]),
		]);
		assert.deepEqual(phasesOf(entries), ["navigate", "reproduce", "patch", "validate"]);
		assert.deepEqual(detectPhaseSignals(entries, CFG), []);
	});

	it("an iterate patch→validate cycle stays quiet", () => {
		const entries = classify([
			turn([bash("grep x /src")]),
			turn([tool("edit", { file_path: "/f.ts" })]),
			turn([bash("npm test")]),
			turn([tool("edit", { file_path: "/f.ts" })]),
			turn([bash("npm test")]),
		]);
		assert.deepEqual(detectPhaseSignals(entries, CFG), []);
	});

	it("a session of pure chat violates nothing", () => {
		const entries = classify([turn([]), turn([])]);
		assert.deepEqual(detectPhaseSignals(entries, CFG), []);
	});
});

describe("premature-patching", () => {
	it("fires when the session's first work is already a patch", () => {
		const entries = classify([turn([bash("git add -A")]), turn([bash("npm test")])]);
		const signals = detectPhaseSignals(entries, CFG);
		assert.deepEqual(kindsOf(signals), ["premature-patching"]);
		assert.equal(signals[0]?.plan_violation, true);
		assert.equal(signals[0]?.phase, "patch");
		assert.deepEqual(signals[0]?.turn_indices, [0]);
	});

	it("stays quiet when navigation or reproduction comes first", () => {
		for (const opener of [turn([bash("git status")]), turn([bash("npm test")])]) {
			const entries = classify([opener, turn([bash("git commit -am fix")]), turn([bash("npm test")])]);
			assert.ok(!kindsOf(detectPhaseSignals(entries, CFG)).includes("premature-patching"));
		}
	});
});

describe("skip-validation", () => {
	it("fires when the session ends on a patch with nothing validating afterwards", () => {
		const entries = classify([turn([bash("git status")]), turn([bash("npm test")]), turn([bash("git add -A")])]);
		const signals = detectPhaseSignals(entries, CFG);
		assert.deepEqual(kindsOf(signals), ["skip-validation"]);
		assert.equal(signals[0]?.plan_violation, true);
		assert.deepEqual(signals[0]?.turn_indices, [2]);
	});

	it("stays quiet once anything validates after the final patch", () => {
		const entries = classify([turn([bash("git status")]), turn([bash("npm test")]), turn([bash("git add -A")]), turn([bash("gh run list")])]);
		// gh run list after a patch validates.
		assert.equal(phasesOf(entries)[3], "validate");
		assert.deepEqual(detectPhaseSignals(entries, CFG), []);
	});
});

describe("no-patch-termination", () => {
	it("fires when real work happened but the session never reached patch phase", () => {
		const entries = classify([turn([bash("git status")]), turn([bash("npm test")]), turn([bash("grep -rn TODO /src")])]);
		const signals = detectPhaseSignals(entries, CFG);
		assert.deepEqual(kindsOf(signals), ["no-patch-termination"]);
		assert.equal(signals[0]?.plan_violation, true);
		assert.deepEqual(signals[0]?.turn_indices, [0, 1, 2]);
		// Each signal carries its turns' opening user messages so evidence walks back to words.
		assert.deepEqual(signals[0]?.user_message_ids, entries.map((e) => e.userMessageId));
	});

	it("stays quiet for a pure-chat session — no work means no plan to violate", () => {
		const entries = classify([turn([]), turn([])]);
		assert.deepEqual(detectPhaseSignals(entries, CFG), []);
	});
});

describe("phase-order-violation", () => {
	it("fires when configured mappings let validation land before any patch", () => {
		const cfg: PhaseTrajectoryConfig = {
			...CFG,
			phaseToolOverrides: { validate: ["make verify"] },
		};
		const entries = classify([turn([bash("make verify")]), turn([bash("git add -A")]), turn([bash("make verify")])], cfg);
		assert.deepEqual(phasesOf(entries), ["validate", "patch", "validate"]);
		const signals = detectPhaseSignals(entries, cfg);
		assert.deepEqual(kindsOf(signals), ["phase-order-violation"]);
		assert.equal(signals[0]?.plan_violation, true);
		assert.equal(signals[0]?.phase, "validate");
	});

	it("stays quiet when the same override sequence follows canonical order", () => {
		const cfg: PhaseTrajectoryConfig = {
			...CFG,
			phaseToolOverrides: { validate: ["make verify"] },
		};
		const entries = classify([turn([bash("git status")]), turn([bash("git add -A")]), turn([bash("make verify")])], cfg);
		assert.deepEqual(detectPhaseSignals(entries, cfg), []);
	});
});

describe("prolonged-stagnation", () => {
	function navRuns(count: number): TurnSourceMessage[][] {
		return Array.from({ length: count }, () => turn([bash("git status")]));
	}

	/** Navigate runs closed out by a proper patch→validate cycle, so ONLY stagnation can fire. */
	function stagnantSession(runLengths: number[], cfg: PhaseTrajectoryConfig): ClassifiedTurn[] {
		return classify(
			[
				...runLengths.flatMap((n) => navRuns(n)),
				turn([bash("git add -A")]),
				turn([bash("npm test")]),
			],
			cfg,
		);
	}

	it("fires at the threshold (default 7) and reports the participating turns", () => {
		const signals = detectPhaseSignals(stagnantSession([7], CFG), CFG);
		assert.equal(signals.length, 1);
		assert.equal(signals[0]?.signal, "prolonged-stagnation");
		assert.equal(signals[0]?.plan_violation, false);
		assert.equal(signals[0]?.count, 7);
		assert.equal(signals[0]?.phase, "navigate");
		assert.deepEqual(signals[0]?.turn_indices, [0, 1, 2, 3, 4, 5, 6]);
	});

	it("stays quiet below the threshold", () => {
		assert.deepEqual(detectPhaseSignals(stagnantSession([6], CFG), CFG), []);
	});

	it("respects a configured threshold and splits separate runs", () => {
		const cfg: PhaseTrajectoryConfig = { ...CFG, stagnationMin: 3 };
		// Two navigate runs of 3 and 4 separated by a single planning turn, closed
		// by a proper patch→validate cycle so only stagnation can fire.
		const entries = classify(
			[
				...navRuns(3),
				turn([]),
				...navRuns(4),
				turn([bash("git add -A")]),
				turn([bash("npm test")]),
			],
			cfg,
		);
		const signals = detectPhaseSignals(entries, cfg);
		assert.deepEqual(
			signals.map((s) => s.count),
			[3, 4],
			"the separate runs are reported as distinct signals",
		);
	});

	it("counts consecutive planning/chat turns too — seven straight turns of talking is stagnation", () => {
		const entries = classify(Array.from({ length: 7 }, () => turn([])));
		const signals = detectPhaseSignals(entries, CFG);
		assert.equal(signals.length, 1);
		assert.equal(signals[0]?.phase, "other");
	});
});
