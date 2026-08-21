/**
 * Unit tests for subagent artifact metadata parsing — the pure half of
 * ingestion. The fixture is hand-written synthetic data shaped like the
 * metadata the host writes for a failed child run; it carries no real session
 * content, no accounts, no request ids.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	parseSubagentArtifact,
	splitArtifactFileName,
	TASK_EXCERPT_CHARS,
} from "../../src/sync/subagent-artifacts.js";

const FIXTURE = path.resolve(
	import.meta.dirname,
	"..",
	"fixtures",
	"subagent-runs",
	"--Users-test--project",
	"subagent-artifacts",
	"6f1c2a4b-9d3e-4f50-8a17-2b5c6d7e8f90_general-purpose_meta.json",
);

describe("splitArtifactFileName", () => {
	it("splits <runId>_<agent>_meta.json at the first underscore", () => {
		assert.deepEqual(splitArtifactFileName("abc-123_general-purpose_meta.json"), {
			runId: "abc-123",
			agent: "general-purpose",
		});
	});

	it("returns null for files that are not artifact metadata", () => {
		assert.equal(splitArtifactFileName("session.jsonl"), null);
		assert.equal(splitArtifactFileName("_meta.json"), null);
		assert.equal(splitArtifactFileName("norunid__meta.json"), null);
	});
});

describe("parseSubagentArtifact", () => {
	it("parses the fixture: exit code, error, attempts, and usage survive verbatim", () => {
		const parsed = parseSubagentArtifact(fs.readFileSync(FIXTURE, "utf-8"), path.basename(FIXTURE));
		assert.ok(parsed);
		assert.equal(parsed.runId, "6f1c2a4b-9d3e-4f50-8a17-2b5c6d7e8f90");
		assert.equal(parsed.agent, "general-purpose");
		assert.equal(parsed.exit_code, 1);
		assert.equal(parsed.error, "spawn pi ENOENT");
		const attempts = JSON.parse(parsed.model_attempts!) as Array<{ model: string; success: boolean }>;
		assert.equal(attempts.length, 1);
		assert.equal(attempts[0]!.model, "anthropic/claude-sonnet-4-5");
		assert.equal(attempts[0]!.success, false);
		const usage = JSON.parse(parsed.usage!) as { turns: number };
		assert.equal(usage.turns, 0);
	});

	it("bounds the task excerpt", () => {
		const longTask = "x".repeat(10_000);
		const parsed = parseSubagentArtifact(
			JSON.stringify({ runId: "r1", agent: "a", task: longTask }),
			"r1_a_meta.json",
		);
		assert.ok(parsed);
		assert.equal(parsed.task_excerpt!.length, TASK_EXCERPT_CHARS);
		assert.equal(parsed.task_excerpt!.length, 300);
	});

	it("keeps unrecorded fields null rather than inventing zeros", () => {
		const parsed = parseSubagentArtifact(JSON.stringify({ runId: "r1", agent: "a" }), "r1_a_meta.json");
		assert.ok(parsed);
		assert.equal(parsed.exit_code, null);
		assert.equal(parsed.error, null);
		assert.equal(parsed.model_attempts, null);
		assert.equal(parsed.usage, null);
		assert.equal(parsed.task_excerpt, null);
	});

	it("falls back to the file name when the body does not name its run", () => {
		const parsed = parseSubagentArtifact(
			JSON.stringify({ exitCode: 1, error: "spawn pi ENOENT" }),
			"run-9_fallback-agent_meta.json",
		);
		assert.ok(parsed);
		assert.equal(parsed.runId, "run-9");
		assert.equal(parsed.agent, "fallback-agent");
		assert.equal(parsed.exit_code, 1);
	});

	it("returns null for a body that names no run anywhere", () => {
		assert.equal(parseSubagentArtifact(JSON.stringify({ exitCode: 1 }), "orphan_meta.json"), null);
	});

	it("returns null for invalid JSON and for non-object bodies", () => {
		assert.equal(parseSubagentArtifact("{not json", "r1_a_meta.json"), null);
		assert.equal(parseSubagentArtifact("[1,2,3]", "r1_a_meta.json"), null);
		assert.equal(parseSubagentArtifact('"a string"', "r1_a_meta.json"), null);
	});
});
