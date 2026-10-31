import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FORMAT, RENDERERS, resolveRenderer, type FingerprintRenderer } from "../../src/fingerprint/renderers.js";
import type { Fingerprint } from "../../src/fingerprint/schema.js";

const fingerprint: Fingerprint = {
	schemaVersion: 2,
	kind: "corpus-fingerprint",
	asOf: "2026-06-30",
	filter: { sources: ["pi", "claude"], from: null, to: null },
	minGroupSize: 5,
	sessions: { count: 12 },
	objective: {
		shape: {
			status: "ok",
			sessionsMeasured: 12,
			promptsPerSession: { status: "ok", sessions: 12, unit: "prompts", p50: 6.5, p90: 9, buckets: [{ from: 0, to: 8, sessions: 7 }, { from: 8, to: null, sessions: 5 }] },
		},
		failures: { status: "withheld", reason: "below-min-group-size" },
	},
	inferred: {},
};

describe("fingerprint renderers", () => {
	it("defaults to JSON and finds a renderer by id", () => {
		assert.equal(DEFAULT_FORMAT, "json");
		assert.equal(resolveRenderer(undefined).id, "json");
		assert.equal(resolveRenderer("csv").mediaType, "text/csv");
	});

	it("names the known formats when asked for an unknown one", () => {
		assert.throws(() => resolveRenderer("xml"), /unknown format 'xml' \(use json, csv\)/);
	});

	it("renders JSON that parses back to the fingerprint", () => {
		assert.deepEqual(JSON.parse(resolveRenderer("json").render(fingerprint)), fingerprint);
	});

	it("renders CSV as metric,value rows, one per figure", () => {
		const lines = resolveRenderer("csv").render(fingerprint).trimEnd().split("\n");
		assert.equal(lines[0], "metric,value");
		assert.ok(lines.includes("schemaVersion,2"));
		assert.ok(lines.includes("filter.sources.1,claude"));
		assert.ok(lines.includes("filter.from,"));
		assert.ok(lines.includes("objective.shape.promptsPerSession.p50,6.5"));
		assert.ok(lines.includes("objective.shape.promptsPerSession.buckets.1.to,"));
		assert.ok(lines.includes("objective.failures.status,withheld"));
	});

	it("takes a renderer from the table it is given, and a renderer sees only the fingerprint", () => {
		const count: FingerprintRenderer = { id: "count", label: "Count", mediaType: "text/plain", render: (fp) => `${fp.sessions.count}\n` };
		assert.equal(resolveRenderer("count", [...RENDERERS, count]).render(fingerprint), "12\n");
	});
});
