/**
 * Unit tests for the child-run failure classes: classification from artifact
 * facts, the remedy-kind axis, and the invariant that an environment class can
 * never produce an install-extension proposal.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	CHILD_FAILURE_CLASSES,
	TOOL_FAILURE_CLASSES,
	TURN_FAILURE_CLASSES,
	classifyChildRun,
	curatedPackages,
	failureClass,
	type ChildRunFacts,
} from "../../src/analyze/analyzers/failure-modes/classes.js";
import {
	buildProposals,
	groupChildRunFailures,
	type ChildRunInput,
	type FailureGroup,
} from "../../src/analyze/analyzers/failure-modes/detect.js";
import { DEFAULT_FAILURE_MODES_CONFIG } from "../../src/analyze/analyzers/failure-modes/config.js";
import type { InstalledPackages } from "../../src/analyze/analyzers/failure-modes/installed.js";

function facts(over: Partial<ChildRunFacts>): ChildRunFacts {
	return { error: "", exitCode: null, allModelAttemptsFailed: false, ...over };
}

function run(over: Partial<ChildRunInput>): ChildRunInput {
	return {
		run_id: "r",
		agent: "general-purpose",
		exit_code: null,
		error: null,
		model_attempts: null,
		usage: null,
		...over,
	};
}

const NOTHING_INSTALLED: InstalledPackages = { names: new Set(), known: true };

describe("classifyChildRun", () => {
	it("reads a spawn ENOENT as a spawn failure, before any structural fact", () => {
		const c = classifyChildRun(facts({ error: "spawn pi ENOENT", exitCode: 1, allModelAttemptsFailed: true }));
		assert.equal(c.classId, "spawn-failure");
		assert.equal(c.label, "the child binary could not be launched");
	});

	it("reads total model-attempt failure as exhaustion", () => {
		const c = classifyChildRun(facts({ allModelAttemptsFailed: true, exitCode: 1 }));
		assert.equal(c.classId, "model-attempt-exhaustion");
		assert.equal(c.label, "every attempted model failed");
	});

	it("reads a non-zero exit with output as a child failure, not a host defect", () => {
		const c = classifyChildRun(facts({ error: "the task could not be completed", exitCode: 2 }));
		assert.equal(c.classId, "child-nonzero-exit");
	});

	it("classifies a healthy run as unclassified — not a gap in the catalogue", () => {
		const c = classifyChildRun(facts({ exitCode: 0 }));
		assert.equal(c.classId, "unclassified");
	});

	it("treats an absent exit code with no error and no failed attempts as unclassified", () => {
		assert.equal(classifyChildRun(facts({})).classId, "unclassified");
	});
});

describe("the remedy-kind axis", () => {
	const ALL_CLASSES = [...TURN_FAILURE_CLASSES, ...TOOL_FAILURE_CLASSES, ...CHILD_FAILURE_CLASSES];

	it("gives every class a remedy kind", () => {
		for (const cls of ALL_CLASSES) {
			assert.ok(
				cls.remedyKind === "extension" || cls.remedyKind === "environment" || cls.remedyKind === "prompt",
				`${cls.id} has no valid remedyKind`,
			);
		}
	});

	it("only extension-kind classes carry extensions", () => {
		for (const cls of ALL_CLASSES) {
			if (cls.remedyKind !== "extension") {
				assert.deepEqual(cls.extensions, [], `${cls.id} is ${cls.remedyKind} but lists extensions`);
			}
		}
	});

	it("every curated package belongs to an extension-kind class", () => {
		// The gate in buildProposals makes non-extension lists unreachable; this
		// keeps the catalogue itself honest so the gate never has to rescue it.
		const fromExtensionClasses = new Set(
			ALL_CLASSES.filter((c) => c.remedyKind === "extension").flatMap((c) => c.extensions.map((e) => e.pkg)),
		);
		for (const pkg of curatedPackages()) {
			assert.ok(fromExtensionClasses.has(pkg), `${pkg} is curated under a non-extension class`);
		}
	});
});

describe("buildProposals never proposes an extension for an environment class", () => {
	function groupFor(classId: string, tool: string, count: number): FailureGroup {
		return {
			axis: failureClass(classId)!.axis,
			class_id: classId,
			tool,
			count,
			message_ids: [],
			causes: [{ label: "test cause", fingerprint: "f", count }],
			cost_usd: null,
			priced_count: 0,
			unpriced_count: count,
		};
	}

	it("routes a repeated spawn failure to an environment target, with no package named", () => {
		const proposals = buildProposals({
			sessionId: "s1",
			groups: [groupFor("spawn-failure", "general-purpose", 3)],
			assistantTurnCount: 10,
			toolCallCount: 20,
			installed: NOTHING_INSTALLED,
			config: DEFAULT_FAILURE_MODES_CONFIG,
		});
		assert.equal(proposals.length, 1);
		const p = proposals[0]!;
		assert.equal(p.target_type, "environment");
		assert.equal(p.target_path, undefined);
		assert.doesNotMatch(p.detail, /npm:/);
		assert.match(p.detail, /PATH|environment|install/i);
	});

	it("routes model-attempt exhaustion to an environment target too", () => {
		const proposals = buildProposals({
			sessionId: "s1",
			groups: [groupFor("model-attempt-exhaustion", "general-purpose", 3)],
			assistantTurnCount: 10,
			toolCallCount: 20,
			installed: NOTHING_INSTALLED,
			config: DEFAULT_FAILURE_MODES_CONFIG,
		});
		assert.equal(proposals.length, 1);
		assert.equal(proposals[0]!.target_type, "environment");
	});

	it("routes child-nonzero-exit to prose guidance, not a package", () => {
		const proposals = buildProposals({
			sessionId: "s1",
			groups: [groupFor("child-nonzero-exit", "general-purpose", 3)],
			assistantTurnCount: 10,
			toolCallCount: 20,
			installed: NOTHING_INSTALLED,
			config: DEFAULT_FAILURE_MODES_CONFIG,
		});
		assert.equal(proposals.length, 1);
		assert.notEqual(proposals[0]!.target_type, "extension");
	});

	it("holds the invariant for every environment class in the catalogue", () => {
		const envClasses = [...TURN_FAILURE_CLASSES, ...TOOL_FAILURE_CLASSES, ...CHILD_FAILURE_CLASSES]
			.filter((c) => c.remedyKind === "environment");
		assert.ok(envClasses.length >= 4, "expected several environment classes");
		for (const cls of envClasses) {
			const proposals = buildProposals({
				sessionId: "s1",
				groups: [groupFor(cls.id, "tool", 99)],
				assistantTurnCount: 100,
				toolCallCount: 100,
				installed: NOTHING_INSTALLED,
				config: DEFAULT_FAILURE_MODES_CONFIG,
			});
			for (const p of proposals) {
				assert.notEqual(p.target_type, "extension", `${cls.id} produced an extension proposal`);
				assert.equal(p.target_path, undefined, `${cls.id} named a package path`);
			}
		}
	});

	it("still proposes an extension for an extension-kind class (the gate is not a ban)", () => {
		const proposals = buildProposals({
			sessionId: "s1",
			groups: [groupFor("rate-limit", "", 3)],
			assistantTurnCount: 10,
			toolCallCount: 20,
			installed: NOTHING_INSTALLED,
			config: DEFAULT_FAILURE_MODES_CONFIG,
		});
		assert.equal(proposals.length, 1);
		assert.equal(proposals[0]!.target_type, "extension");
	});
});

describe("groupChildRunFailures", () => {
	it("groups failed runs by class and agent, dropping healthy runs", () => {
		const groups = groupChildRunFailures([
			run({ run_id: "a", error: "spawn pi ENOENT", exit_code: 1 }),
			run({ run_id: "b", error: "spawn pi ENOENT", exit_code: 1, agent: "Explore" }),
			run({ run_id: "c", exit_code: 0 }),
		]);
		assert.equal(groups.length, 2);
		assert.equal(groups[0]!.axis, "child");
		assert.equal(groups[0]!.class_id, "spawn-failure");
		assert.equal(groups[0]!.tool, "Explore");
		assert.equal(groups[1]!.tool, "general-purpose");
		assert.equal(groups[1]!.count, 1);
		// A spawn failure wrote no messages anywhere; the group says so honestly.
		assert.deepEqual(groups[0]!.message_ids, []);
	});

	it("counts repeat occurrences of the same error as one cause", () => {
		const groups = groupChildRunFailures([
			run({ run_id: "a", error: "spawn pi ENOENT", exit_code: 1 }),
			run({ run_id: "b", error: "spawn pi ENOENT", exit_code: 1 }),
		]);
		assert.equal(groups[0]!.count, 2);
		assert.equal(groups[0]!.causes.length, 1);
		assert.equal(groups[0]!.causes[0]!.count, 2);
	});

	it("prices from recorded usage cost and counts the rest as unpriced", () => {
		const groups = groupChildRunFailures([
			run({ run_id: "a", error: "spawn pi ENOENT", exit_code: 1, usage: JSON.stringify({ cost: 0.5 }) }),
			run({ run_id: "b", error: "spawn pi ENOENT", exit_code: 1, usage: JSON.stringify({ cost: 0 }) }),
		]);
		assert.equal(groups[0]!.priced_count, 1);
		assert.equal(groups[0]!.unpriced_count, 1);
		assert.equal(groups[0]!.cost_usd, 0.5);
	});

	it("classifies attempt exhaustion from the model_attempts JSON", () => {
		const attempts = JSON.stringify([{ model: "m1", success: false }, { model: "m2", success: false }]);
		const groups = groupChildRunFailures([run({ run_id: "a", exit_code: 1, model_attempts: attempts })]);
		assert.equal(groups[0]!.class_id, "model-attempt-exhaustion");
	});

	it("does not read an absent attempt list as total failure", () => {
		const groups = groupChildRunFailures([run({ run_id: "a", exit_code: 1 })]);
		assert.equal(groups[0]!.class_id, "child-nonzero-exit");
	});

	it("returns groups in the canonical deterministic order", () => {
		const groups = groupChildRunFailures([
			run({ run_id: "a", exit_code: 1, agent: "zeta" }),
			run({ run_id: "b", error: "spawn pi ENOENT", exit_code: 1, agent: "alpha" }),
		]);
		// Axis, then class id, then tool — alphabetical within the child axis.
		assert.deepEqual(groups.map((g) => g.class_id), ["child-nonzero-exit", "spawn-failure"]);
		assert.equal(groups[1]!.tool, "alpha");
	});
});
