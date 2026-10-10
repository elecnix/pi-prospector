import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { BUILTIN_ANALYZERS } from "../../src/analyze/defaults.js";
import { COUNT_FIELDS, HARNESSES, KNOWN_ANALYZER_IDS, MAX_COUNT, MAX_ROWS, TRACKER_APP } from "../../src/telemetry/schema.js";

/**
 * The client's report schema and the usage-tracker config it is deployed with
 * (#290) must list the same values: the tracker rejects a count it doesn't
 * know, and stores an analyzer it doesn't know as `other`.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "telemetry", "tracker.config.json"), "utf-8"));
const app = config.apps[TRACKER_APP];

describe("telemetry/tracker.config.json", () => {
	it("lists the client's analyzers, harnesses, and counts, in order", () => {
		assert.deepEqual(app.dimensions.analyzer, [...KNOWN_ANALYZER_IDS]);
		assert.deepEqual(app.dimensions.harness, [...HARNESSES]);
		assert.deepEqual(app.counts, [...COUNT_FIELDS]);
		assert.equal(app.maxRows, MAX_ROWS);
		assert.equal(app.maxCount, MAX_COUNT);
	});

	it("names every built-in analyzer", () => {
		for (const analyzer of BUILTIN_ANALYZERS) assert.ok(app.dimensions.analyzer.includes(analyzer.def.id), `${analyzer.def.id} is missing`);
	});

	it("pins a tracker release", () => {
		assert.match(fs.readFileSync(path.join(ROOT, "telemetry", "tracker-version"), "utf-8").trim(), /^v[0-9]+\.[0-9]+\.[0-9]+$/);
	});
});
