/**
 * Unit tests for plan-compliance metric math and digest formatting (issue
 * #121). Pure functions over hand-written synthetic phase sequences — no
 * database, no LLM, no real session data.
 *
 * Every score is asserted against a hand-computed value on a sequence whose
 * PPC/POC/PPF can be worked out on paper, because a metric nobody can check by
 * hand is a number nobody should trust.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MessageRow } from "../../src/analyze/types.js";
import {
	computePlanCompliance,
	formatComplianceDigestLine,
	type CompliancePhaseEntry,
} from "../../src/analyze/analyzers/plan-compliance/compliance.js";
import { buildDigest } from "../../src/analyze/analyzers/session-overview/digest.js";
import type { PlanComplianceProperties } from "../../src/analyze/analyzers/plan-compliance/index.js";
import type { AnalysisNodeRow } from "../../src/analyze/types.js";
import type { PhaseName } from "../../src/analyze/analyzers/phase-trajectory/config.js";

const ORDER = ["navigate", "reproduce", "patch", "validate"] as const;

function seq(...phases: PhaseName[]): CompliancePhaseEntry[] {
	return phases.map((phase) => ({ phase }));
}

describe("computePlanCompliance — the full canonical cycle", () => {
	it("scores 1.0 across the board when every canonical phase appears in order", () => {
		const s = computePlanCompliance(seq("navigate", "reproduce", "patch", "validate"), ORDER);
		assert.equal(s.ppc, 1);
		assert.equal(s.poc, 1);
		assert.equal(s.ppf, 1);
		assert.equal(s.pc, 1);
		assert.deepEqual(s.skippedPhases, []);
	});

	it("an iterate patch→validate cycle loses only the backward patch hop", () => {
		const s = computePlanCompliance(
			seq("navigate", "patch", "validate", "patch", "validate"),
			ORDER,
		);
		// PPC: reproduce skipped → 3/4. Transitions: nav→patch, patch→val,
		// val→patch (the one backwards hop), patch→val → 4 transitions, 1 out
		// of order → POC = 3/4. PPF: every turn is a plan phase → 1.
		assert.equal(s.ppc, 0.75);
		assert.equal(s.transitions, 4);
		assert.equal(s.outOfOrderTransitions, 1);
		assert.ok(Math.abs(s.poc - 0.75) < 1e-9);
		assert.equal(s.ppf, 1);
	});
});

describe("computePlanCompliance — PPC penalizes skipped phases", () => {
	it("skipping reproduce and validate yields PPC=1/2 and names them in skipped_phases", () => {
		const s = computePlanCompliance(seq("navigate", "patch"), ORDER);
		assert.equal(s.ppc, 0.5, "two of four canonical phases present");
		assert.equal(s.poc, 1, "navigate→patch is forward order");
		assert.equal(s.ppf, 1);
		assert.deepEqual(s.skippedPhases, ["reproduce", "validate"]);
		assert.deepEqual(s.presentPhases, ["navigate", "patch"]);
	});

	it("PC folds the skip in via the geometric mean", () => {
		const s = computePlanCompliance(seq("navigate", "reproduce", "patch"), ORDER);
		// PPC=3/4, POC=1, PPF=1 → PC = cbrt(0.75) ≈ 0.9086.
		assert.ok(Math.abs(s.pc - Math.cbrt(0.75)) < 1e-9);
	});
});

describe("computePlanCompliance — POC penalizes out-of-order transitions", () => {
	it("a backward transition (patch before reproduce) drops POC to 2/3", () => {
		const s = computePlanCompliance(seq("navigate", "patch", "reproduce", "validate"), ORDER);
		assert.equal(s.ppc, 1, "all four phases present");
		const transitions = [
			["navigate", "patch"],
			["patch", "reproduce"],
			["reproduce", "validate"],
		];
		assert.equal(s.transitions, transitions.length);
		assert.equal(s.outOfOrderTransitions, 1, "patch→reproduce moves backwards");
		assert.ok(Math.abs(s.poc - (1 - 1 / 3)) < 1e-9);
		assert.equal(s.ppf, 1);
	});

	it("an `other` interruption that resumes forward order is not disorder", () => {
		const s = computePlanCompliance(seq("navigate", "other", "patch", "validate"), ORDER);
		// The `other` turn creates no transition itself; the move navigate→patch
		// across it is one forward transition.
		assert.equal(s.transitions, 1);
		assert.equal(s.outOfOrderTransitions, 0);
		assert.equal(s.poc, 1);
		assert.equal(s.ppf, 0.75, "one of four turns sat outside the plan");
	});

	it("no transitions at all leaves POC vacuously perfect", () => {
		const s = computePlanCompliance(seq("patch", "patch"), ORDER);
		assert.equal(s.transitions, 0);
		assert.equal(s.poc, 1);
	});
});

describe("computePlanCompliance — PPF penalizes `other` turns", () => {
	it("one planning turn among five turns yields PPF=4/5", () => {
		const s = computePlanCompliance(seq("navigate", "other", "navigate", "patch", "validate"), ORDER);
		assert.equal(s.turnCount, 5);
		assert.equal(s.canonicalTurnCount, 4);
		assert.equal(s.ppf, 0.8);
		assert.equal(s.ppc, 0.75, "reproduce was skipped");
		assert.equal(s.transitions, 2, "nav→patch and patch→val; `other` gaps create none");
		assert.equal(s.poc, 1);
		// PC = cbrt(0.75 * 1 * 0.8).
		assert.ok(Math.abs(s.pc - Math.cbrt(0.75 * 0.8)) < 1e-9);
	});
});

describe("computePlanCompliance — edge cases are decided, not undefined", () => {
	it("an empty sequence demonstrates no compliance: PPC=0, POC=1 (vacuous), PPF=0, PC=0", () => {
		const s = computePlanCompliance([], ORDER);
		assert.equal(s.ppc, 0);
		assert.equal(s.poc, 1);
		assert.equal(s.ppf, 0);
		assert.equal(s.pc, 0);
	});

	it("a pure-chat session has zero compliance scores but no disorder", () => {
		const s = computePlanCompliance(seq("other", "other", "other"), ORDER);
		assert.equal(s.ppc, 0);
		assert.equal(s.transitions, 0);
		assert.equal(s.poc, 1);
		assert.equal(s.ppf, 0);
		assert.ok(s.pc >= 0 && s.pc <= 1);
	});

	it("respects a configured canonical order subset", () => {
		const s = computePlanCompliance(seq("navigate", "patch"), ["navigate", "patch"]);
		assert.equal(s.totalCanonicalPhases, 2);
		assert.equal(s.ppc, 1);
		assert.deepEqual(s.skippedPhases, []);
	});

	it("never divides by zero on an empty configured order", () => {
		const s = computePlanCompliance(seq("navigate"), []);
		assert.equal(s.totalCanonicalPhases, 4, "falls back to the default alphabet");
		assert.equal(s.ppc, 0.25);
	});
});

describe("buildDigest — plan_compliance channel", () => {
	const NO_MESSAGES: MessageRow[] = [];

	function complianceNode(props: PlanComplianceProperties): AnalysisNodeRow {
		return {
			id: "pc-node",
			session_id: "s1",
			analyzer_id: "plan-compliance",
			analyzer_version_id: "1.0.0",
			config_id: "c",
			run_id: null,
			node_kind: "metric",
			content_json: JSON.stringify(props),
			source_set_hash: "ssh",
			config_fingerprint: "",
			input_key: "ik",
			output_key: "ok",
			model_used: null,
			cost_usd: null,
			tokens_used: null,
			input_tokens: null,
			cached_input_tokens: null,
			output_tokens: null,
			duration_ms: null,
			created_at: new Date().toISOString(),
		};
	}

	function complianceNode(props: PlanComplianceProperties): AnalysisNodeRow {
		return {
			id: "pc-node",
			session_id: "s1",
			analyzer_id: "plan-compliance",
			analyzer_version_id: "1.0.0",
			config_id: "c",
			run_id: null,
			node_kind: "metric",
			content_json: JSON.stringify(props),
			source_set_hash: "ssh",
			config_fingerprint: "",
			input_key: "ik",
			output_key: "ok",
			model_used: null,
			cost_usd: null,
			tokens_used: null,
			input_tokens: null,
			cached_input_tokens: null,
			output_tokens: null,
			duration_ms: null,
			created_at: new Date().toISOString(),
		};
	}

	function fullProps(overrides: Partial<PlanComplianceProperties>): PlanComplianceProperties {
		return {
			session_id: "s1",
			ppc: 0.75,
			poc: 0.8,
			ppf: 0.89,
			pc: 0.67,
			present_phases: ["navigate", "reproduce", "patch"],
			skipped_phases: ["validate"],
			total_canonical_phases: 4,
			transitions: 2,
			out_of_order_transitions: 1,
			turn_count: 9,
			canonical_turn_count: 8,
			digest_line: "plan_compliance: PC=0.67 (PPC=0.75, POC=0.80, PPF=0.89); skipped: validate",
			...overrides,
		};
	}

	it("the header carries the plan_compliance line when a compliance node exists", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [],
			llmNodes: [],
			trajectoryNodes: [],
			complianceNodes: [complianceNode(fullProps({}))],
		});
		assert.ok(digest.header.includes("plan_compliance: PC=0.67 (PPC=0.75, POC=0.80, PPF=0.89); skipped: validate"));
		assert.equal(digest.complianceLine?.length ?? 0, digest.complianceLine!.length);
		assert.ok(digest.complianceLine !== null && digest.complianceLine.length < 200, "bounded single line");
	});

	it("the line is absent for a session without a phase node", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [],
			llmNodes: [],
			trajectoryNodes: [],
		});
		assert.equal(digest.complianceLine, null);
		assert.ok(!digest.header.includes("plan_compliance"));
	});
});

describe("formatComplianceDigestLine", () => {
	it("renders the issue #121 example shape with a skipped list", () => {
		const line = formatComplianceDigestLine({
			pc: 0.67,
			ppc: 0.75,
			poc: 0.8,
			ppf: 0.89,
			skipped_phases: ["validate"],
		});
		assert.equal(line, "plan_compliance: PC=0.67 (PPC=0.75, POC=0.80, PPF=0.89); skipped: validate");
		assert.ok(line.length < 120, "the digest line stays bounded");
		assert.ok(!line.includes("\n"), "single line only");
	});

	it("omits the skipped clause when nothing was skipped", () => {
		const line = formatComplianceDigestLine({
			pc: 1,
			ppc: 1,
			poc: 1,
			ppf: 1,
			skipped_phases: [],
		});
		assert.equal(line, "plan_compliance: PC=1.00 (PPC=1.00, POC=1.00, PPF=1.00)");
	});
});
