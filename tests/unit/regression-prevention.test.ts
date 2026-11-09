// Tests for the corpus-level retrospective.
//
// The arithmetic is the product here: a count wrong by one turns "seen twice" into a
// trend. The refusals matter as much — an unclassified class must not file a
// proposal, a vendor break must not count, and the ranking must put the most
// frequent class first.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildProposals,
	severityOf,
	clusterVerdicts,
	proposalFor,
	verdictFromNode,
	type VerdictRow,
} from "../../src/analyze/analyzers/regression-prevention/aggregate.js";

function v(over: Partial<VerdictRow> = {}): VerdictRow {
	return {
		session_id: "s1",
		fixes_defect: true,
		is_regression: true,
		cause: "shared map reached two owners",
		cause_class: "shared_mutable_state",
		prevention_class: "invariant_in_types",
		prevention: "opaque wrapper",
		confidence: 0.8,
		...over,
	};
}

describe("verdictFromNode", () => {
	it("reads a stored verdict", () => {
		const row = verdictFromNode({
			session_id: "s1",
			fixes_defect: true,
			is_regression: true,
			cause: "x",
			cause_class: "order_dependency",
			prevention_class: "invariant_in_types",
			confidence: 0.7,
		});
		assert.ok(row);
		assert.equal(row.cause_class, "order_dependency");
	});

	it("rejects an unknown class as unclassified", () => {
		const row = verdictFromNode({ cause_class: "made_up" });
		assert.ok(row);
		assert.equal(row.cause_class, "unclassified");
		assert.equal(row.prevention_class, "unclassified");
	});

	it("returns null only when there is no object at all", () => {
		assert.equal(verdictFromNode(null), null);
		assert.equal(verdictFromNode(undefined), null);
		assert.equal(verdictFromNode("a string"), null);
	});

	it("reads an empty object as a verdict that claims nothing", () => {
		const row = verdictFromNode({});
		assert.ok(row);
		assert.equal(row.fixes_defect, false);
		assert.equal(row.is_regression, false);
		assert.equal(row.confidence, 0);
	});
});

describe("clusterVerdicts", () => {
	it("counts only regressions that fixed a defect", () => {
		const clusters = clusterVerdicts([
			v({ session_id: "a" }),
			v({ session_id: "b" }),
			v({ session_id: "c", is_regression: false }),
			v({ session_id: "d", fixes_defect: false }),
		]);

		assert.equal(clusters.length, 1);
		assert.equal(clusters[0].occurrences, 2);
	});

	it("ignores a verdict below the confidence floor", () => {
		const clusters = clusterVerdicts([v({ confidence: 0.1 }), v({ session_id: "b", confidence: 0.8 })], {
			minOccurrences: 1,
			maxExamples: 4,
			minConfidence: 0.4,
		});

		assert.equal(clusters[0].occurrences, 1);
	});

	it("ranks the most frequent class first", () => {
		const rows = [
			v({ session_id: "1", cause_class: "missing_test" }),
			v({ session_id: "2", cause_class: "shared_mutable_state" }),
			v({ session_id: "3", cause_class: "shared_mutable_state" }),
			v({ session_id: "4", cause_class: "missing_test" }),
			v({ session_id: "5", cause_class: "shared_mutable_state" }),
		];

		const clusters = clusterVerdicts(rows);

		assert.equal(clusters[0].cause_class, "shared_mutable_state");
		assert.equal(clusters[0].occurrences, 3);
		assert.equal(clusters[1].cause_class, "missing_test");
	});

	it("collects distinct example causes without inventing any", () => {
		const clusters = clusterVerdicts([
			v({ session_id: "1", cause: "the clone was removed" }),
			v({ session_id: "2", cause: "the clone was removed" }),
			v({ session_id: "3", cause: "a second map was shared" }),
		]);

		assert.equal(clusters[0].example_causes.length, 2);
		assert.equal(clusters[0].example_causes[0], "the clone was removed");
	});
});

describe("buildProposals", () => {
	it("files nothing when every class is below the threshold", () => {
		const out = buildProposals([v(), v({ session_id: "b" })], { minOccurrences: 3, maxExamples: 4, minConfidence: 0.4 });

		assert.equal(out.regressions, 2);
		assert.equal(out.improvement_proposals.length, 0);
	});

	it("files a proposal once a class reaches the threshold", () => {
		const rows = [v({ session_id: "1" }), v({ session_id: "2" }), v({ session_id: "3" })];
		const out = buildProposals(rows, { minOccurrences: 3, maxExamples: 4, minConfidence: 0.4 });

		assert.equal(out.improvement_proposals.length, 1);
		assert.match(out.improvement_proposals[0].title, /3 regressions/);
		assert.match(out.improvement_proposals[0].summary, /shared mutable state/);
	});

	it("never files a proposal for the unclassified bucket", () => {
		const rows = Array.from({ length: 5 }, (_, i) => v({ session_id: `s${i}`, cause_class: "unclassified", cause: null }));
		const out = buildProposals(rows, { minOccurrences: 1, maxExamples: 4, minConfidence: 0.4 });

		assert.equal(out.improvement_proposals.length, 0, "an unclassified pile is not a lesson");
	});

	it("re-identifies when the verdict prose changes but the counts do not", () => {
		// The proposals quote the causes, so a re-judge that rewrites them must not keep
		// the old node: same classes, same counts, different words.
		const a = buildProposals([v({ session_id: "1", cause: "the clone was removed" })], { minOccurrences: 1, maxExamples: 4, minConfidence: 0.4 });
		const b = buildProposals([v({ session_id: "1", cause: "the guard was bypassed" })], { minOccurrences: 1, maxExamples: 4, minConfidence: 0.4 });

		assert.notDeepEqual(a.clusters[0].example_causes, b.clusters[0].example_causes);
	});

	it("counts regressions separately from total verdicts", () => {
		const out = buildProposals([v(), v({ is_regression: false }), v({ fixes_defect: false })], {
			minOccurrences: 99,
			maxExamples: 4,
			minConfidence: 0.4,
		});

		assert.equal(out.total_verdicts, 3);
		assert.equal(out.regressions, 1);
	});
});

describe("proposalFor", () => {
	it("states the count it actually saw", () => {
		const p = proposalFor({ cause_class: "missing_test", occurrences: 1, mean_confidence: 0.6, example_causes: ["a test did not exist"], example_sessions: ["s1"] });

		assert.match(p.title, /1 regression/);
		assert.match(p.summary, /once/);
	});

	it("ranks severity against the corpus, not a fixed count", () => {
		// 3 and 12 are both large in absolute terms; what matters is their share of the
		// largest class, so a corpus with a 60-regression class tells them apart.
		assert.equal(severityOf(30, 60), "high");
		assert.equal(severityOf(12, 60), "medium");
		assert.equal(severityOf(3, 60), "low");
		// With nothing larger to compare against, one class is as bad as it gets.
		assert.equal(severityOf(3, 3), "high");
		assert.equal(severityOf(1, 0), "low");
	});

	it("names a change for every class", () => {
		for (const cls of ["missing_test", "shared_mutable_state", "config_drift", "stale_documentation"] as const) {
			const p = proposalFor({ cause_class: cls, occurrences: 3, mean_confidence: 0.6, example_causes: [], example_sessions: [] });
			assert.ok(p.summary.length > 30, `${cls} must name a change`);
		}
	});
});
