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
	it("lists the client's analyzers, harnesses, and counts", () => {
		// The tracker matches values, not positions, so order doesn't matter.
		const sorted = (values: readonly string[]) => [...values].sort();
		assert.deepEqual(sorted(app.dimensions.analyzer), sorted(KNOWN_ANALYZER_IDS));
		assert.deepEqual(sorted(app.dimensions.harness), sorted(HARNESSES));
		assert.deepEqual(sorted(app.counts), sorted(COUNT_FIELDS));
		assert.equal(app.maxRows, MAX_ROWS);
		assert.equal(app.maxCount, MAX_COUNT);
	});

	it("names every built-in analyzer", () => {
		for (const analyzer of BUILTIN_ANALYZERS) assert.ok(app.dimensions.analyzer.includes(analyzer.def.id), `${analyzer.def.id} is missing`);
	});

	it("fits every analyzer and harness pair in one report, so no row is ever dropped", () => {
		assert.ok(KNOWN_ANALYZER_IDS.length * HARNESSES.length <= MAX_ROWS);
	});

	it("fits the largest possible report under the tracker's body limit", async () => {
		const { toReport } = await import("../../src/telemetry/schema.js");
		const full = Object.fromEntries(COUNT_FIELDS.map((field) => [field, MAX_COUNT]));
		const rows = KNOWN_ANALYZER_IDS.flatMap((analyzer) => HARNESSES.map((harness) => ({ analyzer, harness, ...full }) as Parameters<typeof toReport>[2][number]));
		const bytes = Buffer.byteLength(JSON.stringify(toReport("0b5e8c1e-6f0a-4d43-9a7e-3f1d2c4b5a69", "9999.9999.9999", rows)));
		assert.ok(bytes <= config.maxBodyBytes, `${bytes} bytes is over maxBodyBytes ${config.maxBodyBytes}`);
	});

	it("pins a tracker release", () => {
		assert.match(fs.readFileSync(path.join(ROOT, "telemetry", "tracker-version"), "utf-8").trim(), /^v[0-9]+\.[0-9]+\.[0-9]+$/);
	});
});

describe("reported dimensions", () => {
	it("reports an unlisted analyzer as custom and an unlisted source as other", async () => {
		const { reportedAnalyzer, reportedHarness } = await import("../../src/telemetry/schema.js");
		assert.equal(reportedAnalyzer("my-private-analyzer"), "custom");
		assert.equal(reportedAnalyzer("turn-pair-core"), "turn-pair-core");
		assert.equal(reportedHarness("my-source"), "other");
		assert.equal(reportedHarness("claude"), "claude");
	});
});
