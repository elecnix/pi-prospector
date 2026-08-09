import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	emptyAccounting,
	accountOne,
	accountResults,
	runStatus,
	MAX_ERROR_EXAMPLES,
	type RunAccounting,
	type SessionRunOutcome,
} from "../../src/analyze/run-accounting.js";

function clearOutcome(over: Partial<SessionRunOutcome> = {}): SessionRunOutcome {
	return {
		ok: true,
		nodesProduced: 0,
		nodesRevised: 0,
		proposalsCreated: 0,
		costUsd: 0,
		tokensUsed: 0,
		errors: [],
		...over,
	};
}

describe("run accounting", () => {
	it("starts empty", () => {
		const a = emptyAccounting();
		assert.equal(a.attempted, 0);
		assert.equal(a.completed, 0);
		assert.equal(a.failed, 0);
		assert.equal(runStatus(a), "ok");
	});

	it("counts a clean session as completed and folds its tallies", () => {
		const a = accountOne(emptyAccounting(), clearOutcome({ nodesProduced: 4, proposalsCreated: 2, costUsd: 0.5 }));
		assert.equal(a.attempted, 1);
		assert.equal(a.completed, 1);
		assert.equal(a.failed, 0);
		assert.equal(a.nodesProduced, 4);
		assert.equal(a.proposalsCreated, 2);
		assert.equal(a.costUsd, 0.5);
		assert.equal(a.errorCount, 0);
		assert.equal(runStatus(a), "ok");
	});

	it("counts a session with errors as failed and keeps one example", () => {
		const a = accountOne(
			emptyAccounting(),
			clearOutcome({
				ok: false,
				errors: ["turn-pair-llm: LLM call to mid exceeded 120000ms and was aborted"],
			}),
		);
		assert.equal(a.attempted, 1);
		assert.equal(a.completed, 0);
		assert.equal(a.failed, 1);
		assert.equal(a.errorCount, 1);
		assert.deepEqual(a.errorExamples, ["turn-pair-llm: LLM call to mid exceeded 120000ms and was aborted"]);
		assert.equal(runStatus(a), "partial");
	});

	it("counts a thrown session (no summary) as failed", () => {
		const a = accountOne(emptyAccounting(), clearOutcome({ ok: false, errors: ["sess-1: boom"] }));
		assert.equal(a.failed, 1);
		assert.equal(a.errorCount, 1);
		assert.deepEqual(a.errorExamples, ["sess-1: boom"]);
	});

	it("attempted equals the number of outcomes folded", () => {
		const a = accountResults(
			emptyAccounting(),
			[clearOutcome(), clearOutcome({ ok: false, errors: ["x"] }), clearOutcome()],
		);
		assert.equal(a.attempted, 3);
		assert.equal(a.completed, 2);
		assert.equal(a.failed, 1);
		assert.equal(runStatus(a), "partial");
	});

	it("caps retained error examples at MAX_ERROR_EXAMPLES but counts them all", () => {
		const many = Array.from({ length: MAX_ERROR_EXAMPLES * 2 }, (_, i) => `err-${i}`);
		const a = accountOne(emptyAccounting(), clearOutcome({ ok: false, errors: many }));
		assert.equal(a.errorCount, MAX_ERROR_EXAMPLES * 2);
		assert.equal(a.errorExamples.length, MAX_ERROR_EXAMPLES);
	});

	it("does not keep errors for a clean outcome", () => {
		const a = accountOne(emptyAccounting(), clearOutcome({ errors: ["should-be-ignored"] }));
		assert.equal(a.errorCount, 0);
		assert.deepEqual(a.errorExamples, []);
	});
});
