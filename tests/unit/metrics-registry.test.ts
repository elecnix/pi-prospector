/**
 * The metric-definition registry: every definition is sound, every definition
 * belongs to a real analyzer, values listed in a definition match the code that
 * produces them, and the list of analyzers still without definitions is exact.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { BUILTIN_ANALYZERS } from "../../src/analyze/defaults.js";
import {
	METRICS_PENDING,
	analyzersWithoutMetrics,
	getMetric,
	hasMetric,
	listMetrics,
	validateRegistry,
} from "../../src/analyze/metrics/registry.js";
import { CORE_OWNER } from "../../src/analyze/metrics/types.js";
import { CLASSIFY_TOOL } from "../../src/analyze/analyzers/turn-pair-llm/prompt.js";
import { MESSAGE_ORIGINS } from "../../src/analyze/message-origin.js";
import { TEXT_ORIGINS } from "../../src/analyze/text-origin.js";
import { CacheClassification } from "../../src/analyze/analyzers/cache-economy/index.js";
import { ContextEconomyFlag, CompactionCycle } from "../../src/analyze/analyzers/context-economy/index.js";
import { RoutingVerdict } from "../../src/analyze/analyzers/routing-opportunity/index.js";
import { TOOL_INVENTORY_TAX_PROPERTIES } from "../../src/analyze/analyzers/tool-inventory-tax/index.js";
import { PhaseName } from "../../src/analyze/analyzers/phase-trajectory/config.js";
import { PhaseSignalKind } from "../../src/analyze/analyzers/phase-trajectory/classify.js";
import { GROUNDED_CLAIMS_PROPERTIES } from "../../src/analyze/analyzers/grounded-claims/index.js";
import { PULL_REQUEST_PROPERTIES } from "../../src/analyze/analyzers/pr-opened/index.js";
import { SKILL_USE_ENTRY } from "../../src/analyze/analyzers/skill-use/index.js";
import { ClusterFindingSchema } from "../../src/analyze/analyzers/similarity-cluster/index.js";
import { EndingLabelSchema } from "../../src/analyze/analyzers/session-ending/detect.js";
import { NavPattern } from "../../src/analyze/analyzers/navigation-efficiency/detect.js";
import { TargetResolutionKind } from "../../src/analyze/analyzers/task-tool-mismatch/detect.js";
import { LeadTypeSchema } from "../../src/analyze/analyzers/uncompleted-leads/config.js";
import { StaleRunSchema } from "../../src/analyze/analyzers/stale-verification/detect.js";
import { VERIFICATION_VERDICTS } from "../../src/analyze/analyzers/verification-commands/decision.js";

const SRC = path.resolve(import.meta.dirname, "..", "..", "src");
const IDS = BUILTIN_ANALYZERS.map((a) => a.def.id);

function values(id: string): string[] {
	return (getMetric(id)?.values ?? []).map((v) => v.value);
}

/** The literal members of a TypeBox union of literals. */
function literals(schema: { anyOf?: Array<{ const?: unknown }> }): string[] {
	const members = (schema.anyOf ?? []).map((m) => String(m.const));
	assert.ok(members.length > 0, "the schema is not a union of literals, so a comparison against it proves nothing");
	return members;
}

describe("metric definitions", () => {
	it("are sound: schema, id prefix, no duplicates", () => {
		assert.deepEqual(validateRegistry(), []);
	});

	it("belong to a built-in analyzer or to the index itself", () => {
		const owners = new Set(listMetrics().map((m) => m.id.slice(0, m.id.indexOf("."))));
		for (const owner of owners) assert.ok(owner === CORE_OWNER || IDS.includes(owner), `${owner} is neither an analyzer nor '${CORE_OWNER}'`);
	});

	it("call a metric inferred only when the analyzer calls a model", () => {
		for (const metric of listMetrics()) {
			const owner = metric.id.slice(0, metric.id.indexOf("."));
			const analyzer = BUILTIN_ANALYZERS.find((a) => a.def.id === owner);
			if (metric.measurement === "inferred") assert.equal(analyzer?.version.implementationKind, "in_process_llm", `${metric.id} is inferred`);
			if (analyzer?.version.implementationKind === "in_process_llm" && metric.measurement !== "inferred") {
				assert.fail(`${metric.id} comes from a model-calling analyzer, so it is not ${metric.measurement}`);
			}
		}
	});

	it("name series-break versions in major.minor form", () => {
		for (const metric of listMetrics()) {
			for (const b of metric.seriesBreaks ?? []) assert.match(b.version, /^\d+\.\d+$/, metric.id);
		}
	});

	it("list the same values as the code that produces them", () => {
		assert.deepEqual(values("session-ending.ending-label").sort(), literals(EndingLabelSchema).sort());
		assert.deepEqual(values("message-origin.origin").sort(), [...MESSAGE_ORIGINS].sort());
		assert.deepEqual(values("turn-frustration.hit-origin").sort(), [...TEXT_ORIGINS].sort());
		const params = CLASSIFY_TOOL.parameters.properties;
		assert.deepEqual(values("turn-pair-llm.friction-type").sort(), literals(params.friction_type).sort());
		assert.deepEqual(values("turn-pair-llm.sentiment").sort(), literals(params.sentiment).sort());
	});

	it("list the economy analyzers' values as the code produces them", () => {
		assert.deepEqual(values("cache-economy.cache-classification").sort(), literals(CacheClassification).sort());
		assert.deepEqual(values("routing-opportunity.routing-verdict").sort(), literals(RoutingVerdict).sort());
		const kinds = ContextEconomyFlag.anyOf.map((m) => String(m.properties.kind.const));
		assert.deepEqual(values("context-economy.waste-flag").sort(), kinds.sort());
		const flags = Object.keys(CompactionCycle.properties).filter((k) => k.startsWith("fired"));
		assert.deepEqual(values("context-economy.compaction-policy").sort(), flags.sort());
		assert.deepEqual(
			values("tool-inventory-tax.estimated-tax").sort(),
			literals(TOOL_INVENTORY_TAX_PROPERTIES.properties.pricing_method).sort(),
		);
	});

	it("list the same values as the planning and shape analyzers produce", () => {
		assert.deepEqual(values("phase-trajectory.turn-phase").sort(), literals(PhaseName).sort());
		assert.deepEqual(values("phase-trajectory.phase-signal").sort(), literals(PhaseSignalKind).sort());
		const claims = GROUNDED_CLAIMS_PROPERTIES.properties;
		const kinds = literals(claims.claim_kind);
		assert.deepEqual(values("grounded-claims.ungrounded-claim").sort(), kinds.filter((k) => k !== "request").sort());
		assert.deepEqual(values("grounded-claims.unacted-request"), kinds.filter((k) => k === "request"));
		assert.deepEqual(values("pr-opened.pull-request-opened").sort(), literals(PULL_REQUEST_PROPERTIES.properties.via).sort());
		assert.deepEqual(values("skill-use.skill-calls").sort(), literals(SKILL_USE_ENTRY.properties.via).sort());
		assert.deepEqual(values("similarity-cluster.cluster").sort(), literals(ClusterFindingSchema.properties.detector).sort());
	});

	it("list the same values as the code of the tool-use analyzers", () => {
		assert.deepEqual(values("navigation-efficiency.navigation-pattern").sort(), literals(NavPattern).sort());
		assert.deepEqual(values("task-tool-mismatch.target-resolution").sort(), literals(TargetResolutionKind).sort());
		assert.deepEqual(values("uncompleted-leads.lead").sort(), literals(LeadTypeSchema).sort());
		assert.deepEqual(values("stale-verification.stale-cause").sort(), literals(StaleRunSchema.properties.cause).sort());
		assert.deepEqual(values("stale-verification.stale-outcome").sort(), literals(StaleRunSchema.properties.outcome).sort());
		assert.deepEqual(values("verification-commands.verdict").sort(), [...VERIFICATION_VERDICTS].sort());
	});

	it("list every rule code that session-ending can emit", () => {
		const source = fs.readFileSync(path.join(SRC, "analyze", "analyzers", "session-ending", "detect.ts"), "utf8");
		const emitted = new Set([...source.matchAll(/rule = "([a-z_]+)"/g)].map((m) => m[1]!));
		const ternary = [...source.matchAll(/"(no_recorded_results|no_outcome_evidence)"/g)].map((m) => m[1]!);
		for (const t of ternary) emitted.add(t);
		assert.deepEqual(values("session-ending.ending-rule").sort(), [...emitted].sort());
	});

	it("answer hasMetric for a defined id and refuse an invented one", () => {
		assert.ok(hasMetric("failure-modes.tool-failure"));
		assert.ok(!hasMetric("failure-modes.invented"));
	});
});

describe("the coverage gap", () => {
	it("is exactly the list of pending analyzers", () => {
		assert.deepEqual([...analyzersWithoutMetrics(IDS)].sort(), [...METRICS_PENDING].sort());
	});

	it("names only built-in analyzers", () => {
		for (const id of METRICS_PENDING) assert.ok(IDS.includes(id), `${id} is not a built-in analyzer`);
	});
});
