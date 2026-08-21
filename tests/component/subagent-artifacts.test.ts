/**
 * Component tests for subagent artifact ingestion: real SQLite (temp file),
 * real files in a temp sessions root. Proves the incremental contract (a file
 * is re-upserted only when its mtime moves), the project scope, and the
 * directory-nesting join to parent sessions.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tempDb } from "./helpers.js";
import {
	discoverSubagentArtifacts,
	ingestSubagentArtifacts,
} from "../../src/sync/subagent-artifacts.js";
import { getSubagentRunsForSession } from "../../src/db/queries.js";

const FIXTURE = path.resolve(
	import.meta.dirname,
	"..",
	"fixtures",
	"subagent-runs",
	"--Users-test--project",
	"subagent-artifacts",
	"6f1c2a4b-9d3e-4f50-8a17-2b5c6d7e8f90_general-purpose_meta.json",
);

/** A temp sessions root with one project dir and the fixture artifact in it. */
function tempRoot(): { root: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "prospect-artifacts-"));
	const artifactDir = path.join(root, "--Users-test--project", "subagent-artifacts");
	fs.mkdirSync(artifactDir, { recursive: true });
	fs.copyFileSync(FIXTURE, path.join(artifactDir, path.basename(FIXTURE)));
	return {
		root,
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

describe("subagent artifact ingestion", () => {
	it("discovers *_meta.json under each project's subagent-artifacts directory", async () => {
		const { root, cleanup } = tempRoot();
		try {
			const found = await discoverSubagentArtifacts(root);
			assert.equal(found.length, 1);
			assert.equal(found[0]!.project, "--Users-test--project");
			assert.match(found[0]!.filePath, /_meta\.json$/);
		} finally {
			cleanup();
		}
	});

	it("honours a project filter", async () => {
		const { root, cleanup } = tempRoot();
		try {
			assert.equal((await discoverSubagentArtifacts(root, "--Users-other--project")).length, 0);
			assert.equal((await discoverSubagentArtifacts(root, "--Users-test--project")).length, 1);
		} finally {
			cleanup();
		}
	});

	it("upserts the artifact once, skips it unchanged, and re-upserts when mtime moves", async () => {
		const { db, close } = await tempDb();
		const { root, cleanup } = tempRoot();
		try {
			const first = await ingestSubagentArtifacts(db, root);
			assert.equal(first.processed, 1);
			assert.equal(first.skipped, 0);
			assert.deepEqual(first.errors, []);

			const row = (await db
				.prepare("SELECT * FROM subagent_runs WHERE run_id = '6f1c2a4b-9d3e-4f50-8a17-2b5c6d7e8f90'")
				.get()) as Record<string, unknown>;
			assert.equal(row["project"], "--Users-test--project");
			assert.equal(row["exit_code"], 1);
			assert.equal(row["error"], "spawn pi ENOENT");
			assert.ok(typeof row["file_mtime"] === "number");

			// Unchanged file: skipped, not reprocessed — the session cursor contract.
			const second = await ingestSubagentArtifacts(db, root);
			assert.equal(second.processed, 0);
			assert.equal(second.skipped, 1);

			// Moved mtime: re-read and re-upserted.
			const future = Date.now() / 1000 + 60;
			fs.utimesSync(path.join(root, "--Users-test--project", "subagent-artifacts", path.basename(FIXTURE)), future, future);
			const third = await ingestSubagentArtifacts(db, root);
			assert.equal(third.processed, 1);
			assert.equal(third.skipped, 0);
			assert.equal(((await db.prepare("SELECT COUNT(*) AS c FROM subagent_runs").get()) as { c: number }).c, 1);
		} finally {
			cleanup();
			await close();
		}
	});

	it("joins to a parent session by directory nesting on project", async () => {
		const { db, close } = await tempDb();
		const { root, cleanup } = tempRoot();
		try {
			await ingestSubagentArtifacts(db, root);
			await db.prepare(
				"INSERT INTO sessions (id, file_path, project, source, cwd, started_at, last_line, last_modified, message_count, branch_count) " +
					"VALUES ('parent-1', '/tmp/parent-1.jsonl', '--Users-test--project', 'pi', '', '', 0, 0, 0, 0)",
			).run();

			const runs = await getSubagentRunsForSession(db, "parent-1");
			assert.equal(runs.length, 1);
			assert.equal(runs[0]!.run_id, "6f1c2a4b-9d3e-4f50-8a17-2b5c6d7e8f90");
			// A session of another project sees none of them — nesting is the join.
			assert.equal((await getSubagentRunsForSession(db, "other-session")).length, 0);
		} finally {
			cleanup();
			await close();
		}
	});

	it("reports an unparseable artifact in errors instead of dropping it silently", async () => {
		const { db, close } = await tempDb();
		const { root, cleanup } = tempRoot();
		try {
			fs.writeFileSync(
				path.join(root, "--Users-test--project", "subagent-artifacts", "broken_agent_meta.json"),
				"{not json",
			);
			const result = await ingestSubagentArtifacts(db, root);
			assert.equal(result.errors.length, 1);
			assert.match(result.errors[0]!, /broken_agent_meta\.json/);
			assert.equal(result.processed, 1); // the good fixture still lands
		} finally {
			cleanup();
			await close();
		}
	});
});
