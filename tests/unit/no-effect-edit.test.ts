/**
 * Unit tests for NoEffectEdit (issue #255): an edit that replaces a string with
 * itself, reported as a success while changing nothing.
 *
 * All fixtures are hand-written synthetic data — no real session content.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeToolCall } from "../../src/analyze/analyzers/tool-trajectory/arg-parser.js";
import { editReplacements } from "../../src/analyze/analyzers/tool-trajectory/no-effect-edit.js";
import {
	detectAllSignals,
	detectNoEffectEdits,
	detectStuckLoops,
	SIGNAL_RISK_CLASSES,
	type ToolCallWithResult,
} from "../../src/analyze/analyzers/tool-trajectory/detectors.js";
import { computeTrajectoryFriction } from "../../src/analyze/analyzers/tool-trajectory/index.js";
import { DEFAULT_TOOL_TRAJECTORY_CONFIG } from "../../src/analyze/analyzers/tool-trajectory/config.js";
import { classifyFailure } from "../../src/analyze/analyzers/failure-modes/classes.js";

function call(
	name: string,
	args: Record<string, unknown>,
	messageId: string,
	opts: { isError?: boolean; resultMessageId?: string; costUsd?: number | null } = {},
): ToolCallWithResult {
	return {
		call: normalizeToolCall({ name, args, messageId }),
		isError: opts.isError ?? false,
		resultMessageId: opts.resultMessageId ?? `${messageId}-result`,
		costUsd: opts.costUsd ?? null,
		replacements: editReplacements(name, args),
	};
}

const DETECT_CONFIG = {
	stuckLoopMin: 3,
	pollingLoopMin: 3,
	oscillationWindow: 10,
	thoughtOscillationSimilarity: 0.85,
	thoughtOscillationMinRepeat: 2,
};

describe("editReplacements — pi's edit tool", () => {
	it("counts an edits[] entry whose oldText equals its newText", () => {
		assert.deepEqual(
			editReplacements("edit", { path: "src/a.ts", edits: [{ oldText: "const x = 1;", newText: "const x = 1;" }] }),
			{ total: 1, identical: 1 },
		);
	});

	it("counts only the identical entries of a multi-edit call", () => {
		assert.deepEqual(
			editReplacements("edit", {
				path: "src/a.ts",
				edits: [
					{ oldText: "a", newText: "b" },
					{ oldText: "c", newText: "c" },
				],
			}),
			{ total: 2, identical: 1 },
		);
	});

	it("reads the legacy top-level oldText/newText shape", () => {
		assert.deepEqual(editReplacements("edit", { path: "a", oldText: "x", newText: "x" }), { total: 1, identical: 1 });
	});

	it("reads the old_string/new_string shape", () => {
		assert.deepEqual(editReplacements("Edit", { file_path: "a", old_string: "x", new_string: "x" }), { total: 1, identical: 1 });
	});

	it("does not treat a whitespace-only change as a no-op — indentation is a real edit", () => {
		assert.deepEqual(editReplacements("edit", { path: "a", edits: [{ oldText: "  x", newText: "x" }] }), { total: 1, identical: 0 });
		assert.deepEqual(editReplacements("edit", { path: "a", edits: [{ oldText: "x\n", newText: "x" }] }), { total: 1, identical: 0 });
	});

	it("reports nothing for a call that carries no replacement", () => {
		assert.equal(editReplacements("write", { path: "a", content: "x" }), null);
		assert.equal(editReplacements("read", { path: "a" }), null);
	});
});

describe("editReplacements — sed -i", () => {
	const sed = (command: string) => editReplacements("bash", { command });

	it("flags a literal substitution of a string with itself", () => {
		assert.deepEqual(sed("sed -i 's/foo/foo/' src/a.ts"), { total: 1, identical: 1 });
		assert.deepEqual(sed("sed -i 's/foo/foo/g' src/a.ts"), { total: 1, identical: 1 });
	});

	it("does not flag a substitution that changes the text", () => {
		assert.deepEqual(sed("sed -i 's/foo/bar/' src/a.ts"), { total: 1, identical: 0 });
	});

	it("ignores sed without -i: it edits nothing on disk", () => {
		assert.equal(sed("sed 's/foo/foo/' src/a.ts"), null);
	});

	it("does not flag a pattern with regex metacharacters: s/a.b/a.b/ rewrites axb", () => {
		assert.deepEqual(sed("sed -i 's/a.b/a.b/' f"), { total: 1, identical: 0 });
	});

	it("does not flag a replacement that uses & or a case-insensitive flag", () => {
		assert.deepEqual(sed("sed -i 's/&/&/' f"), { total: 1, identical: 0 });
		assert.deepEqual(sed("sed -i 's/foo/foo/I' f"), { total: 1, identical: 0 });
	});

	it("accepts any delimiter, a backup suffix, and BSD's empty suffix", () => {
		assert.deepEqual(sed("sed -i.bak 's|x|x|' f"), { total: 1, identical: 1 });
		assert.deepEqual(sed("sed -i '' 's#x#x#' f"), { total: 1, identical: 1 });
		assert.deepEqual(sed("sed --in-place s/x/x/ f"), { total: 1, identical: 1 });
	});

	it("reads every -e expression and every command of a script", () => {
		assert.deepEqual(sed("sed -i -e 's/a/a/' -e 's/b/c/' f"), { total: 2, identical: 1 });
		assert.deepEqual(sed("sed -i 's/a/a/; s/b/b/' f"), { total: 2, identical: 2 });
	});

	it("finds sed inside a compound command", () => {
		assert.deepEqual(sed("cd src && sed -i 's/x/x/' a.ts && git diff"), { total: 1, identical: 1 });
	});

	it("reports nothing for a command with no sed at all", () => {
		assert.equal(sed("ls -la"), null);
	});
});

describe("detectNoEffectEdits", () => {
	it("emits one signal per successful edit that replaced a string with itself", () => {
		const calls = [
			call("edit", { path: "src/a.ts", edits: [{ oldText: "x", newText: "x" }] }, "m1", { costUsd: 0.02 }),
			call("edit", { path: "src/a.ts", edits: [{ oldText: "x", newText: "y" }] }, "m2"),
			call("bash", { command: "sed -i 's/q/q/' src/b.ts" }, "m3"),
		];
		const signals = detectNoEffectEdits(calls);
		assert.equal(signals.length, 2);
		assert.equal(signals[0]!.pattern, "no-effect-edit");
		assert.deepEqual(signals[0]!.messageIds, ["m1"]);
		assert.equal(signals[0]!.count, 1);
		assert.equal(signals[0]!.cost_usd, 0.02);
		assert.equal(signals[0]!.riskClass, SIGNAL_RISK_CLASSES["no-effect-edit"]);
		assert.match(signals[0]!.description, /src\/a\.ts/);
		assert.deepEqual(signals[1]!.messageIds, ["m3"]);
		assert.equal(signals[1]!.tool, "bash");
	});

	it("counts the identical replacements of a partly no-op multi-edit", () => {
		const signals = detectNoEffectEdits([
			call("edit", { path: "a", edits: [{ oldText: "a", newText: "a" }, { oldText: "b", newText: "b" }, { oldText: "c", newText: "d" }] }, "m1"),
		]);
		assert.equal(signals.length, 1);
		assert.equal(signals[0]!.count, 2);
		assert.match(signals[0]!.description, /2 of 3/);
	});

	it("skips an edit the tool rejected: that failure is failure-modes' to classify", () => {
		assert.deepEqual(detectNoEffectEdits([call("edit", { path: "a", oldText: "x", newText: "x" }, "m1", { isError: true })]), []);
	});

	it("skips an edit whose result never arrived: success is not known", () => {
		assert.deepEqual(detectNoEffectEdits([call("edit", { path: "a", oldText: "x", newText: "x" }, "m1", { resultMessageId: "" })]), []);
	});

	it("is part of detectAllSignals, and a clean session still produces none", () => {
		const noisy = detectAllSignals([call("edit", { path: "a", oldText: "x", newText: "x" }, "m1")], [], DETECT_CONFIG);
		assert.deepEqual(noisy.map((s) => s.pattern), ["no-effect-edit"]);
		const clean = detectAllSignals([call("edit", { path: "a", oldText: "x", newText: "y" }, "m1")], [], DETECT_CONFIG);
		assert.deepEqual(clean, []);
	});
});

describe("no-op edits feed the repeated-failed-edit stuck-loop", () => {
	it("repeated no-op edits to one file are a stuck-loop, though each reported success", () => {
		const calls = [1, 2, 3].map((i) => call("edit", { path: "src/a.ts", oldText: "x", newText: "x" }, `m${i}`));
		const loops = detectStuckLoops(calls, 3);
		assert.equal(loops.length, 1);
		assert.equal(loops[0]!.count, 3);
	});

	it("a real change in the run is progress and ends it", () => {
		const calls = [
			call("edit", { path: "src/a.ts", oldText: "x", newText: "x" }, "m1"),
			call("edit", { path: "src/a.ts", oldText: "x", newText: "x" }, "m2"),
			call("edit", { path: "src/a.ts", oldText: "x", newText: "y" }, "m3"),
		];
		assert.deepEqual(detectStuckLoops(calls, 3), []);
	});

	it("edits to different files are not one loop", () => {
		const calls = ["a", "b", "c"].map((p, i) => call("edit", { path: `src/${p}.ts`, oldText: "x", newText: "x" }, `m${i}`));
		assert.deepEqual(detectStuckLoops(calls, 3), []);
	});
});

describe("no-effect-edit friction weight", () => {
	it("contributes its configured weight × the non-blocking multiplier", () => {
		const [signal] = detectNoEffectEdits([call("edit", { path: "a", oldText: "x", newText: "x" }, "m1")]);
		const score = computeTrajectoryFriction([signal!], DEFAULT_TOOL_TRAJECTORY_CONFIG);
		assert.equal(score, DEFAULT_TOOL_TRAJECTORY_CONFIG.noEffectEditWeight * DEFAULT_TOOL_TRAJECTORY_CONFIG.nonBlockingRiskMultiplier);
		assert.ok(score > 0);
	});
});

describe("failure-modes: a rejected no-op edit", () => {
	it("is classified as a no-effect edit, not as an anchor miss", () => {
		const text = "No changes made to src/a.ts. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.";
		assert.equal(classifyFailure(text, "tool").classId, "no-effect-edit");
		assert.equal(classifyFailure("No changes made to src/a.ts. The replacements produced identical content.", "tool").classId, "no-effect-edit");
	});

	it("leaves a genuine anchor miss where it was", () => {
		assert.equal(classifyFailure("Could not find edits[0] in src/a.ts.", "tool").classId, "edit-anchor-miss");
	});
});
