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
import { EndingLabelSchema } from "../../src/analyze/analyzers/session-ending/detect.js";

const SRC = path.resolve(import.meta.dirname, "..", "..", "src");
const IDS = BUILTIN_ANALYZERS.map((a) => a.def.id);

function values(id: string): string[] {
	return (getMetric(id)?.values ?? []).map((v) => v.value);
}

/** The literal members of a TypeBox union of literals. */
function literals(schema: { anyOf?: Array<{ const?: unknown }> }): string[] {
	return (schema.anyOf ?? []).map((m) => String(m.const));
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
