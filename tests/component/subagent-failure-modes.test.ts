/**
 * Component test: the failure-modes analyzer classifying child-run failures
 * end-to-end through the real framework and real SQLite. The child runs are
 * inserted exactly as sync's artifact ingestion leaves them; no real session
 * data, no network, no LLM.
 *
 * Proves that a spawn-level failure — which wrote no assistant messages
 * anywhere — is classified from artifact metadata, proposed as an *environment*
 * remedy (never an extension), and survives an idempotent re-run.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AsyncDatabase } from "../src/db/async-db.js";
import { tempDb } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { failureModesAnalyzer, FAILURE_MODES_DEF, type FailureModesProperties } from "../../src/analyze/analyzers/failure-modes/index.js";
import { upsertSubagentRun } from "../../src/db/queries.js";

const PROJECT = "--Users-test--project";

function settingsWith(packages: unknown[]): string {
	const file = path.join(os.tmpdir(), `prospect-sfm-settings-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
	fs.writeFileSync(file, JSON.stringify({ packages }));
	return file;
}

async function withSettings<T>(file: string, fn: () => Promise<T>): Promise<T> {
	const prior = process.env["PROSPECTOR_PI_SETTINGS"];
	process.env["PROSPECTOR_PI_SETTINGS"] = file;
	try {
		return await fn();
	} finally {
		if (prior === undefined) delete process.env["PROSPECTOR_PI_SETTINGS"];
		else process.env["PROSPECTOR_PI_SETTINGS"] = prior;
	}
}

/** A session in the project plus three spawn-failed child runs beside it. */
async function seed(db: AsyncDatabase): void  {
	await db.prepare(
		"INSERT INTO sessions (id, file_path, project, source, cwd, started_at, last_line, last_modified, message_count, branch_count) " +
			"VALUES ('parent-1', '/tmp/parent-1.jsonl', ?, 'pi', '', '', 0, 0, 0, 0)",
	).run(PROJECT);
	for (let i = 1; i <= 3; i++) {
		upsertSubagentRun(db, {
			run_id: `spawn-fail-${i}`,
			project: PROJECT,
			agent: "general-purpose",
			task_excerpt: "Do a thing",
			exit_code: 1,
			error: "spawn pi ENOENT",
			model_attempts: JSON.stringify([{ model: "anthropic/claude-sonnet-4-5", success: false, exitCode: 1, error: "spawn pi ENOENT" }]),
			usage: JSON.stringify({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }),
			file_mtime: 1_700_000_000_000 + i,
		});
	}
}

async function readProps(db: AsyncDatabase): Promise<FailureModesProperties> {
	const rows = (await db
		.prepare("SELECT content_json FROM analysis_nodes WHERE analyzer_id = ? ORDER BY created_at ASC, id ASC")
		.all(FAILURE_MODES_DEF.id)) as Array<{ content_json: string }>;
	assert.ok(rows.length >= 1, "expected a failure-modes node");
	return JSON.parse(rows[rows.length - 1]!.content_json) as FailureModesProperties;
}

describe("failure-modes over subagent runs", () => {
	it("classifies spawn failures from artifacts and proposes an environment remedy, never an extension", async () => {
		const { db, close } = await tempDb();
		const settings = settingsWith([]);
		try {
			seed(db);
			const fw = new AnalyzerFramework({
				db,
				llm: createMockLLM({ fallback: "" }).caller,
				modelTiers: DEFAULT_MODEL_TIERS,
			});
			await fw.register(failureModesAnalyzer);
			await withSettings(settings, () => fw.run("parent-1", { analyzerIds: ["failure-modes"] }));

			const props = await readProps(db);
			assert.equal(props.child_run_count, 3);
			assert.equal(props.child_run_failure_count, 3);

			const [proposal] = props.improvement_proposals;
			assert.ok(proposal, "three repeated spawn failures earn a proposal");
			assert.match(proposal.title, /child spawn failure/);
			assert.equal(proposal.target_type, "environment");
			assert.equal(proposal.target_path, undefined);
			assert.doesNotMatch(proposal.detail, /npm:/);
			assert.match(proposal.evidence, /3 child run\(s\) recorded in artifact metadata/);

			// Materialised into the proposal store with the same environment target.
			const stored = await db.prepare("SELECT target_type, target_path FROM proposals").all() as Array<{ target_type: string; target_path: string | null }>;
			assert.equal(stored.length, 1);
			assert.equal(stored[0]!.target_type, "environment");
			assert.equal(stored[0]!.target_path, null);
		} finally {
			fs.unlinkSync(settings);
			await close();
		}
	});

	it("is idempotent: a re-run reproduces the same node instead of stacking findings", async () => {
		const { db, close } = await tempDb();
		const settings = settingsWith([]);
		try {
			await seed(db);
			const fw = new AnalyzerFramework({
				db,
				llm: createMockLLM({ fallback: "" }).caller,
				modelTiers: DEFAULT_MODEL_TIERS,
			});
			await fw.register(failureModesAnalyzer);
			await withSettings(settings, () => fw.run("parent-1", { analyzerIds: ["failure-modes"] }));
			await withSettings(settings, () => fw.run("parent-1", { analyzerIds: ["failure-modes"] }));

			const nodes = ((await db
				.prepare("SELECT COUNT(*) AS c FROM analysis_nodes WHERE analyzer_id = ? AND node_kind != 'error'")
				.get(FAILURE_MODES_DEF.id)) as { c: number });
			assert.equal(nodes.c, 1);
			assert.equal((await readProps(db)).child_run_failure_count, 3);
		} finally {
			fs.unlinkSync(settings);
			await close();
		}
	});

	it("re-identifies when new artifact metadata is ingested", async () => {
		const { db, close } = await tempDb();
		const settings = settingsWith([]);
		try {
			seed(db);
			const fw = new AnalyzerFramework({
				db,
				llm: createMockLLM({ fallback: "" }).caller,
				modelTiers: DEFAULT_MODEL_TIERS,
			});
			await fw.register(failureModesAnalyzer);
			await withSettings(settings, () => fw.run("parent-1", { analyzerIds: ["failure-modes"] }));

			upsertSubagentRun(db, {
				run_id: "exhausted-1",
				project: PROJECT,
				agent: "general-purpose",
				task_excerpt: null,
				exit_code: 1,
				error: null,
				model_attempts: JSON.stringify([{ model: "m1", success: false }, { model: "m2", success: false }]),
				usage: null,
				file_mtime: 1_800_000_000_000,
			});
			await withSettings(settings, () => fw.run("parent-1", { analyzerIds: ["failure-modes"] }));

			const props = await readProps(db);
			assert.equal(props.child_run_failure_count, 4);
			const exhaustion = props.groups.find((g) => g.class_id === "model-attempt-exhaustion");
			assert.ok(exhaustion, "the exhausted run is its own group");
			assert.equal(exhaustion.count, 1);
		} finally {
			fs.unlinkSync(settings);
			await close();
		}
	});
});
