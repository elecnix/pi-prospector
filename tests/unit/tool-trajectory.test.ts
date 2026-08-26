/**
 * Unit tests for tool-trajectory detector functions and argument parsing.
 *
 * All fixtures are hand-written synthetic data — no real session content.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeToolCall, isNearIdentical, isExactlyIdentical, type NormalizedToolCall } from "../../src/analyze/analyzers/tool-trajectory/arg-parser.js";
import { detectStuckLoops, detectPollingLoops, detectOscillation, detectPreFlightGaps, detectAllSignals, detectThoughtOscillation, SIGNAL_RISK_CLASSES, type ReasoningBlock, type ToolCallWithResult } from "../../src/analyze/analyzers/tool-trajectory/detectors.js";
import { computeTrajectoryFriction } from "../../src/analyze/analyzers/tool-trajectory/index.js";
import { DEFAULT_TOOL_TRAJECTORY_CONFIG, type ToolTrajectoryConfig } from "../../src/analyze/analyzers/tool-trajectory/config.js";

// ──────────────────── helpers ────────────────────

function makeBashCall(command: string, messageId: string, isError = false, costUsd: number | null = null): ToolCallWithResult {
	const call = normalizeToolCall({ name: "bash", args: { command }, messageId });
	return { call, isError, resultMessageId: `${messageId}-result`, costUsd };
}

function makeToolCall(name: string, args: Record<string, unknown>, messageId: string, isError = false, costUsd: number | null = null): ToolCallWithResult {
	const call = normalizeToolCall({ name, args, messageId });
	return { call, isError, resultMessageId: `${messageId}-result`, costUsd };
}

// ──────────────────── arg-parser tests ────────────────────

describe("normalizeToolCall", () => {
	it("normalises a simple bash command", () => {
		const result = normalizeToolCall({ name: "bash", args: { command: "ls -la /tmp" }, messageId: "m1" });
		assert.equal(result.tool, "bash");
		assert.equal(result.subcommand, "ls");
		assert.equal(result.readOnly, true);
	});

	it("normalises a git command", () => {
		const result = normalizeToolCall({ name: "bash", args: { command: "git push origin main" }, messageId: "m1" });
		assert.equal(result.subcommand, "git push");
		assert.equal(result.target, "main");
		assert.equal(result.readOnly, false);
	});

	it("normalises a gh command", () => {
		const result = normalizeToolCall({ name: "bash", args: { command: "gh pr view 29" }, messageId: "m1" });
		assert.equal(result.subcommand, "gh pr view");
		assert.equal(result.target, "29");
		assert.equal(result.readOnly, true);
	});

	it("normalises a git status command as read-only", () => {
		const result = normalizeToolCall({ name: "bash", args: { command: "git status" }, messageId: "m1" });
		assert.equal(result.readOnly, true);
		assert.equal(result.subcommand, "git status");
	});

	it("normalises an edit tool call with file path", () => {
		const result = normalizeToolCall({ name: "edit", args: { file_path: "/src/index.ts" }, messageId: "m1" });
		assert.equal(result.tool, "edit");
		assert.equal(result.target, "/src/index.ts");
		assert.equal(result.readOnly, false);
	});

	it("normalises a read tool call as read-only", () => {
		const result = normalizeToolCall({ name: "read", args: { file_path: "/src/index.ts" }, messageId: "m1" });
		assert.equal(result.tool, "read");
		assert.equal(result.target, "/src/index.ts");
		assert.equal(result.readOnly, true);
	});

	it("sorts flags in a bash command", () => {
		const result = normalizeToolCall({ name: "bash", args: { command: "ls -la --sort=size /tmp" }, messageId: "m1" });
		assert.ok(result.normalizedArgs.includes("--sort=size") || result.normalizedArgs.includes("ls"));
		// Flags should be sorted: -a -l (or -la) before --sort
	});

	it("handles bash command with no arguments", () => {
		const result = normalizeToolCall({ name: "bash", args: { command: "pwd" }, messageId: "m1" });
		assert.equal(result.subcommand, "pwd");
		assert.equal(result.readOnly, true);
	});
});

describe("isNearIdentical", () => {
	it("matches calls with same tool and target", () => {
		const a = normalizeToolCall({ name: "bash", args: { command: "gh pr view 29" }, messageId: "m1" });
		const b = normalizeToolCall({ name: "bash", args: { command: "gh pr view 29 --json state" }, messageId: "m2" });
		assert.equal(isNearIdentical(a, b), true);
	});

	it("rejects calls with different subcommands", () => {
		const a = normalizeToolCall({ name: "bash", args: { command: "gh pr view 29" }, messageId: "m1" });
		const b = normalizeToolCall({ name: "bash", args: { command: "gh pr list" }, messageId: "m2" });
		assert.equal(isNearIdentical(a, b), false);
	});

	it("rejects calls with different tools", () => {
		const a = normalizeToolCall({ name: "edit", args: { file_path: "/foo" }, messageId: "m1" });
		const b = normalizeToolCall({ name: "read", args: { file_path: "/foo" }, messageId: "m2" });
		assert.equal(isNearIdentical(a, b), false);
	});
});

describe("isExactlyIdentical", () => {
	it("matches calls with same tool and identical normalised args", () => {
		const a = normalizeToolCall({ name: "bash", args: { command: "git status" }, messageId: "m1" });
		const b = normalizeToolCall({ name: "bash", args: { command: "git status" }, messageId: "m2" });
		assert.equal(isExactlyIdentical(a, b), true);
	});

	it("rejects calls with different args", () => {
		const a = normalizeToolCall({ name: "bash", args: { command: "gh pr view 29" }, messageId: "m1" });
		const b = normalizeToolCall({ name: "bash", args: { command: "gh pr view 30" }, messageId: "m2" });
		assert.equal(isExactlyIdentical(a, b), false);
	});
});

// ──────────────────── detector tests ────────────────────

describe("detectStuckLoops", () => {
	it("detects a stuck loop of 3 identical failed bash calls", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("npm install", "m1", true),
			makeBashCall("npm install", "m2", true),
			makeBashCall("npm install", "m3", true),
		];
		const signals = detectStuckLoops(calls, 3);
		assert.equal(signals.length, 1);
		assert.equal(signals[0]!.pattern, "stuck-loop");
		assert.equal(signals[0]!.count, 3);
		assert.ok(signals[0]!.description.includes("npm install"));
	});

	it("does not flag a run under the threshold", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("npm install", "m1", true),
			makeBashCall("npm install", "m2", true),
		];
		const signals = detectStuckLoops(calls, 3);
		assert.equal(signals.length, 0);
	});

	it("does not flag a run that eventually succeeds", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("npm install", "m1", true),
			makeBashCall("npm install", "m2", true),
			makeBashCall("npm install", "m3", false),
		];
		const signals = detectStuckLoops(calls, 3);
		assert.equal(signals.length, 0);
	});

	it("detects gh pr view polling pattern", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("gh pr view 29", "m1", false),
			makeBashCall("gh pr view 29", "m2", false),
			makeBashCall("gh pr view 29", "m3", false),
			makeBashCall("gh pr view 29", "m4", false),
			makeBashCall("gh pr view 29", "m5", false),
		];
		// Stuck-loop with threshold 3 won't trigger because they all succeed (no error)
		const stuckSignals = detectStuckLoops(calls, 3);
		assert.equal(stuckSignals.length, 0);
	});

	// ── pricing (issue #71) ──

	it("prices a stuck-loop as the sum of its participating turns' billed cost", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("npm install", "m1", true, 0.2),
			makeBashCall("npm install", "m2", true, 0.3),
			makeBashCall("npm install", "m3", true, 0.5),
		];
		const signals = detectStuckLoops(calls, 3);
		assert.equal(signals.length, 1);
		assert.equal(signals[0]!.cost_usd, 1);
	});

	it("leaves a signal unpriced (null) when no participant has a recorded cost", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("npm install", "m1", true),
			makeBashCall("npm install", "m2", true),
			makeBashCall("npm install", "m3", true),
		];
		const signals = detectStuckLoops(calls, 3);
		assert.equal(signals.length, 1);
		assert.equal(signals[0]!.cost_usd, null);
	});

	it("treats a zero-priced signal as unpriced, never a silent free", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("npm install", "m1", true, 0),
			makeBashCall("npm install", "m2", true, 0),
			makeBashCall("npm install", "m3", true, 0),
		];
		const signals = detectStuckLoops(calls, 3);
		assert.equal(signals[0]!.cost_usd, null);
	});

	it("skips unpriced participants when pricing a partly-priced run", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("npm install", "m1", true, 0.25),
			makeBashCall("npm install", "m2", true), // no recorded cost
			makeBashCall("npm install", "m3", true, 0.15),
		];
		const signals = detectStuckLoops(calls, 3);
		assert.equal(signals[0]!.cost_usd, 0.4);
	});
});

describe("detectPollingLoops", () => {
	it("detects a polling loop of 3+ identical read-only calls", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("gh pr view 29", "m1", false),
			makeBashCall("gh pr view 29", "m2", false),
			makeBashCall("gh pr view 29", "m3", false),
			makeBashCall("gh pr view 29", "m4", false),
			makeBashCall("gh pr view 29", "m5", false),
		];
		const signals = detectPollingLoops(calls, 3);
		assert.equal(signals.length, 1);
		assert.equal(signals[0]!.pattern, "polling-loop");
		assert.equal(signals[0]!.count, 5);
	});

	it("does not flag mutating commands as polling", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("git push origin main", "m1", false),
			makeBashCall("git push origin main", "m2", false),
			makeBashCall("git push origin main", "m3", false),
		];
		const signals = detectPollingLoops(calls, 3);
		assert.equal(signals.length, 0);
	});

	it("detects git status polling", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("git status", "m1", false),
			makeBashCall("git status", "m2", false),
			makeBashCall("git status", "m3", false),
		];
		const signals = detectPollingLoops(calls, 3);
		assert.equal(signals.length, 1);
		assert.equal(signals[0]!.pattern, "polling-loop");
	});

	it("splits polling into separate runs when interleaved with other commands", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("git status", "m1", false),
			makeBashCall("git status", "m2", false),
			// interleaved different command
			makeBashCall("git diff", "m3", false),
			makeBashCall("git status", "m4", false),
			makeBashCall("git status", "m5", false),
			makeBashCall("git status", "m6", false),
		];
		const signals = detectPollingLoops(calls, 3);
		// Only one run of 3 consecutive git status (m4-m6)
		assert.equal(signals.length, 1);
		assert.equal(signals[0]!.count, 3);
	});
});

describe("detectOscillation", () => {
	it("detects git checkout oscillation (x → y → x)", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("git checkout main", "m1", false),
			makeBashCall("git checkout feature", "m2", false),
			makeBashCall("git checkout main", "m3", false),
		];
		const signals = detectOscillation(calls, 10);
		assert.ok(signals.length >= 1);
		assert.equal(signals[0]!.pattern, "oscillation");
		assert.ok(signals[0]!.description.includes("Checkout") || signals[0]!.description.includes("checkout"));
	});

	it("detects push-force oscillation on same ref", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("git push origin main", "m1", false),
			makeBashCall("git push --force origin main", "m2", false),
		];
		const signals = detectOscillation(calls, 10);
		assert.ok(signals.length >= 1);
		assert.equal(signals[0]!.pattern, "oscillation");
	});

	it("does not flag unrelated commands outside the window", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("git checkout main", "m1", false),
			// Fill with many unrelated commands
			...Array.from({ length: 15 }, (_, i) => makeBashCall(`npm test`, `m${i + 2}`, false)),
			makeBashCall("git checkout feature", "m17", false),
		];
		const signals = detectOscillation(calls, 10);
		assert.equal(signals.length, 0);
	});
});

describe("detectPreFlightGaps", () => {
	it("detects mv into non-existent directory", () => {
		const calls: ToolCallWithResult[] = [
			// No mkdir for /nonexistent
			makeBashCall("mv file.txt /nonexistent/dest.txt", "m1", true),
		];
		const signals = detectPreFlightGaps(calls);
		assert.equal(signals.length, 1);
		assert.equal(signals[0]!.pattern, "pre-flight-gap");
		assert.ok(signals[0]!.description.includes("nonexistent"));
	});

	it("does not flag mv when mkdir was done earlier", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("mkdir /target", "m0", false),
			makeBashCall("mv file.txt /target/dest.txt", "m1", true),
		];
		const signals = detectPreFlightGaps(calls);
		assert.equal(signals.length, 0);
	});

	it("detects write to non-existent parent directory", () => {
		const calls: ToolCallWithResult[] = [
			makeToolCall("write", { file_path: "/nonexistent/sub/file.ts" }, "m1", true),
		];
		const signals = detectPreFlightGaps(calls);
		assert.equal(signals.length, 1);
		assert.equal(signals[0]!.pattern, "pre-flight-gap");
		assert.ok(signals[0]!.description.includes("nonexistent"));
	});

	it("does not flag successful commands", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("mv file.txt /nonexistent/dest.txt", "m1", false),
		];
		const signals = detectPreFlightGaps(calls);
		assert.equal(signals.length, 0);
	});
});

describe("detectAllSignals", () => {
	it("deduplicates stuck-loops that are fully contained in polling-loops", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("gh pr view 29", "m1", true),
			makeBashCall("gh pr view 29", "m2", true),
			makeBashCall("gh pr view 29", "m3", true),
		];
		const signals = detectAllSignals(calls, [], {
			stuckLoopMin: 3,
			pollingLoopMin: 3,
			oscillationWindow: 10,
			thoughtOscillationSimilarity: 0.85,
			thoughtOscillationMinRepeat: 2,
		});
		// Should have a polling-loop (read-only) and NOT a stuck-loop that
		// duplicates the same messages
		const polling = signals.filter((s) => s.pattern === "polling-loop");
		const stuck = signals.filter((s) => s.pattern === "stuck-loop");
		assert.ok(polling.length >= 1, "should detect polling-loop");
		// Stuck-loops whose message ids are fully contained in polling-loops should be filtered
		const pollingMsgIds = new Set(polling.flatMap((p) => p.messageIds));
		const duplicateStuck = stuck.filter((s) => s.messageIds.every((id) => pollingMsgIds.has(id)));
		assert.equal(duplicateStuck.length, 0, "stuck-loop should not duplicate polling-loop");
	});

	it("returns empty signals for a clean session", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("npm test", "m1", false),
			makeBashCall("git status", "m2", false),
			makeBashCall("git add .", "m3", false),
			makeBashCall("git commit -m 'fix'", "m4", false),
		];
		const signals = detectAllSignals(calls, [], {
			stuckLoopMin: 3,
			pollingLoopMin: 3,
			oscillationWindow: 10,
			thoughtOscillationSimilarity: 0.85,
			thoughtOscillationMinRepeat: 2,
		});
		assert.equal(signals.length, 0);
	});
});
// ──────────────────── risk grading (issue #119) ────────────────────

describe("signal risk classes", () => {
	it("grades every pattern per the issue's table", () => {
		assert.deepEqual(SIGNAL_RISK_CLASSES, {
			"stuck-loop": "non-blocking",
			"polling-loop": "non-blocking",
			"oscillation": "blocking",
			"thought-oscillation": "blocking",
			"pre-flight-gap": "non-blocking",
		});
	});

	it("carries its expected risk class on each detected signal", () => {
		const stuck = detectStuckLoops([
			makeBashCall("npm install", "m1", true),
			makeBashCall("npm install", "m2", true),
			makeBashCall("npm install", "m3", true),
		], 3);
		const polling = detectPollingLoops([
			makeBashCall("gh pr view 29", "m1", false),
			makeBashCall("gh pr view 29", "m2", false),
			makeBashCall("gh pr view 29", "m3", false),
		], 3);
		const oscillation = detectOscillation([
			makeBashCall("git checkout main", "m1", false),
			makeBashCall("git checkout feature", "m2", false),
			makeBashCall("git checkout main", "m3", false),
		], 10);
		const preFlight = detectPreFlightGaps([
			makeBashCall("mv file.txt /nonexistent/dest.txt", "m1", true),
		]);

		assert.equal(stuck.length, 1);
		assert.equal(stuck[0]!.riskClass, "non-blocking");
		assert.equal(polling.length, 1);
		assert.equal(polling[0]!.riskClass, "non-blocking");
		assert.ok(oscillation.length >= 1);
		assert.equal(oscillation[0]!.riskClass, "blocking");
		assert.equal(preFlight.length, 1);
		assert.equal(preFlight[0]!.riskClass, "non-blocking");
	});

	it("carries the blocking class on a detected thought-oscillation", () => {
		const blocks = [
			makeBlock("m1", 0, BASE_THOUGHT),
			makeBlock("m2", 1, NEAR_DUPLICATE_THOUGHT),
			makeBlock("m3", 2, BASE_THOUGHT),
		];
		const signals = detectThoughtOscillation(blocks, OSC_CONFIG);
		assert.equal(signals.length, 1);
		assert.equal(signals[0]!.riskClass, "blocking");
	});
});

describe("risk-graded friction weighting", () => {
	// One action oscillation: the canonical blocking-class signal.
	function oscillationSignal() {
		const signals = detectOscillation([
			makeBashCall("git checkout main", "m1", false),
			makeBashCall("git checkout feature", "m2", false),
			makeBashCall("git checkout main", "m3", false),
		], 10);
		assert.ok(signals.length >= 1);
		return signals[0]!;
	}

	it("a blocking signal contributes weight × 2 (default blocking multiplier)", () => {
		const score = computeTrajectoryFriction([oscillationSignal()], DEFAULT_TOOL_TRAJECTORY_CONFIG);
		const expected = DEFAULT_TOOL_TRAJECTORY_CONFIG.oscillationWeight * DEFAULT_TOOL_TRAJECTORY_CONFIG.blockingRiskMultiplier;
		assert.ok(Math.abs(score - expected) < 1e-9, `expected ${expected}, got ${score}`);
	});

	it("the same signal graded non-blocking contributes weight × 1", () => {
		const asBlocking = computeTrajectoryFriction([oscillationSignal()], DEFAULT_TOOL_TRAJECTORY_CONFIG);
		const sameSignalNonBlocking = { ...oscillationSignal(), riskClass: "non-blocking" as const };
		const asNonBlocking = computeTrajectoryFriction([sameSignalNonBlocking], DEFAULT_TOOL_TRAJECTORY_CONFIG);
		assert.ok(Math.abs(asNonBlocking - DEFAULT_TOOL_TRAJECTORY_CONFIG.oscillationWeight) < 1e-9);
		assert.ok(
			Math.abs(asBlocking - 2 * asNonBlocking) < 1e-9,
			`blocking (${asBlocking}) should weigh twice non-blocking (${asNonBlocking})`,
		);
	});

	it("a non-blocking signal contributes weight × 1 under defaults", () => {
		const signals = detectStuckLoops([
			makeBashCall("npm install", "m1", true),
			makeBashCall("npm install", "m2", true),
			makeBashCall("npm install", "m3", true),
		], 3);
		const score = computeTrajectoryFriction(signals, DEFAULT_TOOL_TRAJECTORY_CONFIG);
		assert.ok(Math.abs(score - DEFAULT_TOOL_TRAJECTORY_CONFIG.stuckLoopWeight * DEFAULT_TOOL_TRAJECTORY_CONFIG.nonBlockingRiskMultiplier) < 1e-9);
	});

	it("respects configured multipliers instead of the defaults", () => {
		const config: ToolTrajectoryConfig = { ...DEFAULT_TOOL_TRAJECTORY_CONFIG, oscillationWeight: 0.2, blockingRiskMultiplier: 3.5, nonBlockingRiskMultiplier: 0.5 };
		const blockingScore = computeTrajectoryFriction([oscillationSignal()], config);
		assert.ok(Math.abs(blockingScore - 0.2 * 3.5) < 1e-9, `expected 0.7, got ${blockingScore}`);
	});
});

// ──────────────────── thought-oscillation (issue #117) ────────────────────

import {
	normalizeReasoningText,
	reasoningShingles,
	fingerprintReasoning,
	fingerprintSimilarity,
	fingerprintHex,
} from "../../src/analyze/analyzers/tool-trajectory/reasoning-fingerprint.js";

/**
 * An ~80-word synthetic reasoning block. Long enough that a single word swap
 * leaves Jaccard similarity above the default 0.85 threshold — which is exactly
 * what "near-duplicate" means here: the same dead end re-stated, not rewritten.
 */
const BASE_THOUGHT =
	"The integration test keeps failing because the framework never receives the reasoning payload " +
	"that the parser is supposed to carry alongside tool calls. I keep arriving at the same conclusion: " +
	"extract the private thinking before serialising each assistant message, then compare fingerprints " +
	"across successive turns instead of comparing raw text. The sliding window should bound how far apart " +
	"two blocks may sit while still counting as members of one oscillation run. Once that lands, the " +
	"detector will finally see the loop.";

/** The same dead end re-stated with one word changed — a near-duplicate of BASE_THOUGHT. */
const NEAR_DUPLICATE_THOUGHT = BASE_THOUGHT.replace("finally", "eventually");

/** A genuine rewrite: same topic, different wording, different shingles throughout. */
const PARAPHRASED_THOUGHT =
	"Our suite fails again since no private reasoning ever reaches the host layer when calls ride along " +
	"in the same generation. The fix I keep circling back to is capturing those hidden fragments early " +
	"and hashing them so later attempts can be measured against earlier ones inside a bounded span. With " +
	"that in place the recurring pattern would become visible to analysis.";

describe("reasoning fingerprints", () => {
	it("normalises case and whitespace", () => {
		assert.equal(normalizeReasoningText("  Same   TEXT\nhere "), "same text here");
	});

	it("strips code blocks, paths and URLs before shingling", () => {
		const withNoise = normalizeReasoningText(
			"Check src/analyze/index.ts and https://example.com/doc now\n```ts\nconst x: number = 1;\n```\nplease",
		);
		assert.equal(withNoise, "check and now please");
		assert.deepEqual(reasoningShingles(withNoise), []);
	});

	it("matches near-duplicate reasoning above the default threshold", () => {
		const a = fingerprintReasoning(BASE_THOUGHT);
		const b = fingerprintReasoning(NEAR_DUPLICATE_THOUGHT);
		assert.ok(a && b);
		const sim = fingerprintSimilarity(a!, b!);
		assert.ok(sim >= 0.85, `expected >= 0.85, got ${sim}`);
	});

	it("does not match paraphrased reasoning", () => {
		const a = fingerprintReasoning(BASE_THOUGHT);
		const b = fingerprintReasoning(PARAPHRASED_THOUGHT);
		assert.ok(a && b);
		assert.ok(fingerprintSimilarity(a!, b!) < 0.5, `paraphrase scored ${fingerprintSimilarity(a!, b!)}`);
	});

	it("strips code so code-heavy blocks with identical prose match fully", () => {
		const a = fingerprintReasoning(
			'Restate the plan.\n```ts\nfunction helperA(x: number): number { return x * 2; }\n```\nRerun the failing suite after extracting reasoning first.',
		);
		const b = fingerprintReasoning(
			'Restate the plan.\n```ts\nimport { readFile } from "node:fs/promises";\nexport async function load(p: string) { return readFile(p, "utf8"); }\n```\nRerun the failing suite after extracting reasoning first.',
		);
		assert.ok(a && b);
		assert.equal(fingerprintSimilarity(a!, b!), 1);
	});

	it("refuses to fingerprint prose too short for even one shingle", () => {
		assert.equal(fingerprintReasoning("still failing"), null);
		assert.equal(fingerprintReasoning(""), null);
	});

	it("renders a stable hex digest", () => {
		const a = fingerprintReasoning(BASE_THOUGHT);
		const b = fingerprintReasoning(BASE_THOUGHT);
		assert.ok(a && b);
		assert.equal(fingerprintHex(a!), fingerprintHex(b!));
	});
});

// ──────────────────── detectThoughtOscillation ────────────────────

import type { ReasoningBlock } from "../../src/analyze/analyzers/tool-trajectory/detectors.js";

function makeBlock(
	messageId: string,
	turnIndex: number,
	text: string,
	opts: { stateChanging?: boolean; costUsd?: number | null } = {},
): ReasoningBlock {
	const fp = fingerprintReasoning(text);
	assert.ok(fp, "test fixture must be long enough to fingerprint");
	return {
		messageId,
		turnIndex,
		stateChanging: opts.stateChanging ?? false,
		fingerprint: fp,
		costUsd: opts.costUsd ?? null,
	};
}

const OSC_CONFIG = { oscillationWindow: 10, thoughtOscillationSimilarity: 0.85, thoughtOscillationMinRepeat: 2 };

describe("detectThoughtOscillation", () => {
	it("fires on a run of repeated no-action thinking turns within the window", () => {
		const blocks = [
			makeBlock("m1", 0, BASE_THOUGHT),
			makeBlock("m2", 1, NEAR_DUPLICATE_THOUGHT),
			makeBlock("m3", 2, BASE_THOUGHT),
		];
		const signals = detectThoughtOscillation(blocks, OSC_CONFIG);
		assert.equal(signals.length, 1);
		assert.equal(signals[0]!.pattern, "thought-oscillation");
		assert.equal(signals[0]!.count, 3);
		assert.deepEqual(signals[0]!.messageIds, ["m1", "m2", "m3"]);
		assert.ok((signals[0]!.similarity ?? 0) >= 0.85, `similarity was ${signals[0]!.similarity}`);
		assert.ok(signals[0]!.description.includes("Thought oscillation"));
	});

	it("prices itself from the participating turns' billed cost", () => {
		const blocks = [
			makeBlock("m1", 0, BASE_THOUGHT, { costUsd: 0.1 }),
			makeBlock("m2", 1, NEAR_DUPLICATE_THOUGHT, { costUsd: 0.25 }),
			makeBlock("m3", 2, BASE_THOUGHT),
		];
		const signals = detectThoughtOscillation(blocks, OSC_CONFIG);
		assert.equal(signals.length, 1);
		assert.equal(signals[0]!.cost_usd, 0.35);
	});

	it("stays quiet on reconsider-then-act: a state-changing turn breaks the run", () => {
		const blocks = [
			makeBlock("m1", 0, BASE_THOUGHT),
			makeBlock("m2", 1, NEAR_DUPLICATE_THOUGHT, { stateChanging: true }),
			makeBlock("m3", 2, BASE_THOUGHT),
		];
		assert.equal(detectThoughtOscillation(blocks, OSC_CONFIG).length, 0);
	});

	it("stays quiet on a single repetition (one repetition is reconsideration)", () => {
		const blocks = [
			makeBlock("m1", 0, BASE_THOUGHT),
			makeBlock("m2", 1, NEAR_DUPLICATE_THOUGHT),
		];
		assert.equal(detectThoughtOscillation(blocks, OSC_CONFIG).length, 0);
	});

	it("respects the window boundary between consecutive run members", () => {
		// Gap of 11 turns between the second and third block exceeds window 10:
		// the run splits into [t0,t1] (one repetition, quiet) and [t12].
		const apart = [
			makeBlock("m1", 0, BASE_THOUGHT),
			makeBlock("m2", 1, NEAR_DUPLICATE_THOUGHT),
			makeBlock("m3", 12, BASE_THOUGHT),
		];
		assert.equal(detectThoughtOscillation(apart, OSC_CONFIG).length, 0);

		// Gap of exactly 10 turns is still within the window.
		const atLimit = [
			makeBlock("m1", 0, BASE_THOUGHT),
			makeBlock("m2", 1, NEAR_DUPLICATE_THOUGHT),
			makeBlock("m3", 11, BASE_THOUGHT),
		];
		const signals = detectThoughtOscillation(atLimit, OSC_CONFIG);
		assert.equal(signals.length, 1);
		assert.equal(signals[0]!.count, 3);
	});

	it("does not merge two honest runs separated by an action", () => {
		const blocks = [
			makeBlock("m1", 0, BASE_THOUGHT),
			makeBlock("m2", 1, BASE_THOUGHT, { stateChanging: true }),
			makeBlock("m3", 2, BASE_THOUGHT),
		];
		assert.equal(detectThoughtOscillation(blocks, OSC_CONFIG).length, 0);
	});

	it("a paraphrased block ends the run instead of extending it", () => {
		const blocks = [
			makeBlock("m1", 0, BASE_THOUGHT),
			makeBlock("m2", 1, NEAR_DUPLICATE_THOUGHT),
			makeBlock("m3", 2, PARAPHRASED_THOUGHT),
			makeBlock("m4", 3, BASE_THOUGHT),
		];
		assert.equal(detectThoughtOscillation(blocks, OSC_CONFIG).length, 0);
	});
});
