import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderJson, renderMarkdown } from "../../src/analyze/metrics/render.js";
import type { MetricDefinition } from "../../src/analyze/metrics/types.js";

const METRIC: MetricDefinition = {
	id: "demo.thing",
	name: "A thing",
	definition: "Counts things.",
	measurement: "counted",
	unit: "things per session",
	denominator: "sessions",
	values: [{ value: "a", meaning: "first" }],
	limitations: ["Misses some things."],
	seriesBreaks: [{ version: "1.1", effect: "Counts more.", repair: "prospect analyze --revise minor" }],
};

const FACTS = new Map([["demo", { version: "1.2", implementation: "deterministic" }]]);

describe("renderMarkdown", () => {
	it("shows the definition, the limits, the series breaks and the live version", () => {
		const md = renderMarkdown([METRIC], FACTS);
		assert.match(md, /## demo \(version 1\.2, deterministic\)/);
		assert.match(md, /Id: `demo\.thing`/);
		assert.match(md, /\*\*Definition\*\*: Counts things\./);
		assert.match(md, /`a`: first/);
		assert.match(md, /Misses some things\./);
		assert.match(md, /Version 1\.1: Counts more\. Repair: `prospect analyze --revise minor`/);
	});

	it("omits the version for an owner that is not an analyzer", () => {
		assert.match(renderMarkdown([METRIC], new Map()), /^## demo$/m);
	});
});

describe("owner of an id", () => {
	it("is the text before the first dot, and the whole id when it has no dot", () => {
		const dotless: MetricDefinition = { ...METRIC, id: "sessions" };
		assert.match(renderMarkdown([dotless], new Map()), /^## sessions$/m);
	});
});

describe("renderJson", () => {
	it("returns the definitions with their owner and facts", () => {
		const parsed = JSON.parse(renderJson([METRIC], FACTS)) as Array<Record<string, unknown>>;
		assert.equal(parsed[0]!["owner"], "demo");
		assert.equal(parsed[0]!["version"], "1.2");
		assert.equal(parsed[0]!["id"], "demo.thing");
	});
});
