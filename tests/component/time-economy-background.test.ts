/**
 * Component tests for the time-economy analyzer's second wave of measures,
 * exercised end-to-end through the real sync path and the real
 * AnalyzerFramework (issue #306).
 *
 * The fixture is a hand-written synthetic Claude Code transcript — no real
 * session data — that carries every shape the new measures read: a
 * backgrounded call whose completion the host recorded, a pipe that hid a
 * failure's exit code, a commit with a preparation span, and a skill that
 * occupied the agent.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { openAsyncDatabase, type AsyncDatabase } from "../../src/db/async-db.js";
import { migrate } from "../../src/db/schema.js";
import { runSync } from "../../src/sync/index.js";
import { ClaudeFileSource } from "../../src/sync/sources/claude-file.js";
import { getBackgroundTasksForSession } from "../../src/db/queries.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { timeEconomyAnalyzer } from "../../src/analyze/analyzers/time-economy/index.js";
import { claudeSessionFileName, claudeSessionId } from "./helpers.js";

const T0 = Date.parse("2026-03-01T10:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

async function tempDb(): Promise<{ db: AsyncDatabase; close: () => Promise<void> }> {
	const dbPath = path.join(os.tmpdir(), `prospect-te-bg-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
	const db = openAsyncDatabase(dbPath);
	await migrate(db);
	return { db, close: async () => { await db.close(); for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ } } } };
}

/**
 * A synthetic Claude Code transcript with the four shapes the new measures
 * read. Hand-written, deterministic, and free of any real session content.
 */
function fixtureLines(): string[] {
	const lines: string[] = [];
	const push = (o: unknown) => lines.push(JSON.stringify(o));

	// The human's request opens the session.
	push({
		type: "user",
		uuid: "u-1",
		parentUuid: null,
		timestamp: at(0),
		cwd: "/home/dev/project",
		message: { role: "user", content: "Build the release and open a pull request." },
	});

	// A backgrounded build: the call returns at once, and the host records the
	// real completion in a separate queue-operation record.
	push({
		type: "assistant",
		uuid: "a-1",
		parentUuid: "u-1",
		timestamp: at(10),
		message: {
			role: "assistant",
			model: "claude-sonnet",
			content: [{ type: "tool_use", id: "toolu-bg", name: "Bash", input: { command: "npm run build", run_in_background: true } }],
		},
	});
	push({
		type: "user",
		uuid: "r-1",
		parentUuid: "a-1",
		timestamp: at(11),
		message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-bg", content: "Command running in background with ID b1" }] },
	});
	push({
		type: "queue-operation",
		operation: "enqueue",
		timestamp: at(310),
		sessionId: "session",
		content: [
			"<task-notification>",
			"<task-id>b1</task-id>",
			"<tool-use-id>toolu-bg</tool-use-id>",
			"<output-file>/tmp/tasks/b1.output</output-file>",
			"<status>completed</status>",
			"<summary>Background command \"npm run build\" completed (exit code 0)</summary>",
			"</task-notification>",
		].join("\n"),
	});

	// A test run behind a pipe: the harness sees tail's exit status, so the
	// call is a success while the output shows the failure.
	push({
		type: "assistant",
		uuid: "a-2",
		parentUuid: "u-1",
		timestamp: at(320),
		message: {
			role: "assistant",
			model: "claude-sonnet",
			content: [{ type: "tool_use", id: "toolu-test", name: "Bash", input: { command: "npm test 2>&1 | tail -40" } }],
		},
	});
	push({
		type: "user",
		uuid: "r-2",
		parentUuid: "a-2",
		timestamp: at(380),
		message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-test", content: "--- FAIL: test_release (0.03s)\n1 failed, 12 passed" }] },
	});

	// The pull-request skill opens, and a `gh pr create` ends it.
	push({
		type: "assistant",
		uuid: "a-3",
		parentUuid: "u-1",
		timestamp: at(400),
		message: {
			role: "assistant",
			model: "claude-sonnet",
			content: [{ type: "tool_use", id: "toolu-skill", name: "Skill", input: { skill: "pr" } }],
		},
	});
	push({
		type: "assistant",
		uuid: "a-4",
		parentUuid: "u-1",
		timestamp: at(500),
		message: {
			role: "assistant",
			model: "claude-sonnet",
			content: [{ type: "tool_use", id: "toolu-pr", name: "Bash", input: { command: "gh pr create --title 'Add release'" } }],
		},
	});
	push({
		type: "user",
		uuid: "r-3",
		parentUuid: "a-4",
		timestamp: at(520),
		message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-pr", content: "https://github.com/example/project/pull/7" }] },
	});

	// A test run, then a commit: the preparation span between them.
	push({
		type: "assistant",
		uuid: "a-5",
		parentUuid: "u-1",
		timestamp: at(540),
		message: {
			role: "assistant",
			model: "claude-sonnet",
			content: [{ type: "tool_use", id: "toolu-test2", name: "Bash", input: { command: "npm test" } }],
		},
	});
	push({
		type: "user",
		uuid: "r-4",
		parentUuid: "a-5",
		timestamp: at(600),
		message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-test2", content: "12 passed" }] },
	});
	push({
		type: "assistant",
		uuid: "a-6",
		parentUuid: "u-1",
		timestamp: at(620),
		message: {
			role: "assistant",
			model: "claude-sonnet",
			content: [{ type: "tool_use", id: "toolu-commit", name: "Bash", input: { command: "git commit -m 'Add the release pipeline'" } }],
		},
	});
	push({
		type: "user",
		uuid: "r-5",
		parentUuid: "a-6",
		timestamp: at(630),
		message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-commit", content: "[main 1a2b3c4] Add the release pipeline" }] },
	});

	return lines;
}

/** Write the fixture into a temp Claude sessions root and return its path and id. */
function writeFixture(): { root: string; sessionId: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "prospect-te-bg-home-"));
	const projectDir = path.join(root, ".claude", "projects", "-home-dev-project");
	fs.mkdirSync(projectDir, { recursive: true });
	const label = "te-bg-session";
	const sessionId = claudeSessionId(label);
	fs.writeFileSync(path.join(projectDir, claudeSessionFileName(label)), fixtureLines().join("\n") + "\n");
	return { root, sessionId, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe("time-economy: background calls, hidden exit codes, phase and skill spans", () => {
	it("measures every new shape from a real Claude transcript", async () => {
		const { db, close } = await tempDb();
		const fixture = writeFixture();
		try {
			const claudeDir = path.join(fixture.root, ".claude", "projects");
			const sync = await runSync(db, [new ClaudeFileSource(claudeDir)], {});
			assert.equal(sync.errors.length, 0, `sync should have no errors: ${sync.errors.join("; ")}`);
			assert.equal(sync.sessionsProcessed, 1);

			// The background task's completion was ingested.
			const tasks = await getBackgroundTasksForSession(db, fixture.sessionId);
			assert.equal(tasks.length, 1);
			assert.equal(tasks[0]?.tool_use_id, "toolu-bg");
			assert.equal(tasks[0]?.status, "completed");
			assert.equal(tasks[0]?.completed_at, at(310));

			// The analyzer runs over the synced session.
			const fw = new AnalyzerFramework({
				db,
				llm: createMockLLM({ responder: () => "unused by this analyzer" }).caller,
				modelTiers: DEFAULT_MODEL_TIERS,
			});
			await fw.register(timeEconomyAnalyzer);
			const summary = await fw.run(fixture.sessionId, {});
			assert.equal(summary.errors.length, 0, `run should have no errors: ${summary.errors.join("; ")}`);

			const nodes = (await db
				.prepare("SELECT node_kind, content_json FROM analysis_nodes WHERE analyzer_id = ?")
				.all("time-economy")) as Array<{ node_kind: string; content_json: string }>;
			assert.equal(nodes.length, 1);
			const content = JSON.parse(nodes[0]!.content_json) as Record<string, any>;

			// The background call is timed by the host's completion record, not by
			// the acknowledgement that came back at once.
			const background = content["background_calls"];
			assert.equal(background.timed_call_count, 1);
			assert.equal(background.seconds, 300, "the build ran from second 10 to second 310");
			assert.equal(background.calls[0].status, "completed");

			// The pipe hid the test run's failure from the exit code.
			const hidden = content["hidden_exit_codes"];
			assert.equal(hidden.length, 1);
			assert.equal(hidden[0].family, "npm test");

			// The phase span: the session's start to its first commit, and the
			// commit's own preparation.
			const spans = content["phase_spans"] as Array<Record<string, any>>;
			const start = spans.find((s) => s.kind === "start_to_first_commit");
			assert.ok(start, "a start-to-first-commit span is measured");
			assert.equal(start.end_reason, "commit");
			assert.equal(start.commit_subject, "Add the release pipeline");
			assert.equal(start.seconds, 620, "the session ran from second 0 to the commit at 620");

			const preparation = spans.find((s) => s.kind === "commit_preparation");
			assert.ok(preparation, "a commit-preparation span is measured");
			// There is no previous commit, so the preparation starts at the
			// session's first *passing* test run — the piped run at second 320
			// failed, and a failed run prepared nothing. The passing run is
			// at second 540, and the commit at 620.
			assert.equal(preparation.seconds, 80);

			// The skill span: it opens at the Skill call and ends at the
			// successful `gh pr create`.
			const skills = content["skill_spans"] as Array<Record<string, any>>;
			assert.equal(skills.length, 1);
			assert.equal(skills[0].skill, "pr");
			assert.equal(skills[0].end_reason, "pr_created");
			assert.equal(skills[0].seconds, 120, "the skill ran from second 400 to the PR at 520");
		} finally {
			await close();
			fixture.cleanup();
		}
	});

	it("proposes a change when a pipe hid a failure often enough", async () => {
		const { db, close } = await tempDb();
		const fixture = writeFixture();
		try {
			const claudeDir = path.join(fixture.root, ".claude", "projects");
			await runSync(db, [new ClaudeFileSource(claudeDir)], {});

			const fw = new AnalyzerFramework({
				db,
				llm: createMockLLM({ responder: () => "unused by this analyzer" }).caller,
				modelTiers: DEFAULT_MODEL_TIERS,
				// One hidden failure is a slip; three are a habit.
				configOverrides: { "time-economy": { hiddenExitProposalMinCalls: 1 } },
			});
			await fw.register(timeEconomyAnalyzer);
			await fw.run(fixture.sessionId, {});

			const proposals = (await db
				.prepare("SELECT title, severity FROM proposals WHERE analyzer_id = ?")
				.all("time-economy")) as Array<{ title: string; severity: string }>;
			const hidden = proposals.find((p) => p.title.includes("reported success while the output showed a failure"));
			assert.ok(hidden, `a hidden-exit-code proposal is expected: ${JSON.stringify(proposals)}`);
			assert.equal(hidden.severity, "friction");
		} finally {
			await close();
			fixture.cleanup();
		}
	});

	it("refuses to analyse a unit that carries no measured snapshot", async () => {
		// The spans and the background completions are measured in plan(),
		// because that is where the usage column can be read, and they are
		// the same inputs the unit's fingerprint covers. Analysing without
		// them would write a node whose content and identity describe
		// different inputs, so the analyzer refuses rather than guessing.
		const { db, close } = await tempDb();
		const fixture = writeFixture();
		try {
			const claudeDir = path.join(fixture.root, ".claude", "projects");
			await runSync(db, [new ClaudeFileSource(claudeDir)], {});

			const fw = new AnalyzerFramework({
				db,
				llm: createMockLLM({ responder: () => "unused by this analyzer" }).caller,
				modelTiers: DEFAULT_MODEL_TIERS,
			});
			await fw.register(timeEconomyAnalyzer);
			const planCtx = {
				sessionId: fixture.sessionId,
				messages: (await db
					.prepare("SELECT id, session_id, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, model, cost_usd, stop_reason, error_message FROM messages WHERE session_id = ? ORDER BY rowid ASC")
					.all(fixture.sessionId)) as never,
				allNodes: [],
				ownNodes: [],
				dependencyNodes: {},
				getGlobalDependencyNodes: async () => [],
				getTurnPairs: async () => [],
				config: {},
				db,
			};
			const units = await timeEconomyAnalyzer.plan(planCtx as never);
			assert.equal(units.length, 1);
			// A unit whose snapshot was dropped.
			const stripped = { ...units[0]!, meta: {} };
			await assert.rejects(
				() =>
					timeEconomyAnalyzer.analyze(stripped, {
						sessionId: fixture.sessionId,
						getSessionMessages: async () => [],
						getBackgroundTasks: async () => [],
						config: { configJson: {} },
					} as never),
				/carries no measured snapshot/,
			);
		} finally {
			await close();
			fixture.cleanup();
		}
	});

	it("re-running the same recipe is idempotent", async () => {
		const { db, close } = await tempDb();
		const fixture = writeFixture();
		try {
			const claudeDir = path.join(fixture.root, ".claude", "projects");
			await runSync(db, [new ClaudeFileSource(claudeDir)], {});

			const fw = new AnalyzerFramework({
				db,
				llm: createMockLLM({ responder: () => "unused by this analyzer" }).caller,
				modelTiers: DEFAULT_MODEL_TIERS,
			});
			await fw.register(timeEconomyAnalyzer);
			await fw.run(fixture.sessionId, {});
			const second = await fw.run(fixture.sessionId, {});
			assert.equal(second.nodesProduced, 0, "a second plain fill produces nothing");
			assert.equal(second.nodesSkipped, 1);
		} finally {
			await close();
			fixture.cleanup();
		}
	});

	it("re-identifies the unit when a background completion arrives late", async () => {
		const { db, close } = await tempDb();
		const fixture = writeFixture();
		try {
			const claudeDir = path.join(fixture.root, ".claude", "projects");
			await runSync(db, [new ClaudeFileSource(claudeDir)], {});

			const fw = new AnalyzerFramework({
				db,
				llm: createMockLLM({ responder: () => "unused by this analyzer" }).caller,
				modelTiers: DEFAULT_MODEL_TIERS,
			});
			await fw.register(timeEconomyAnalyzer);
			await fw.run(fixture.sessionId, {});
			const before = (await db
				.prepare("SELECT input_key, content_json FROM analysis_nodes WHERE analyzer_id = ?")
				.all("time-economy")) as Array<{ input_key: string; content_json: string }>;
			assert.equal(before.length, 1);

			// A background task that finished later: the transcript gained a
			// completion record, so the node's inputs changed and the unit must
			// be missing again rather than reused with stale content.
			await db
				.prepare(
					"INSERT INTO background_tasks (session_id, tool_use_id, task_id, completed_at, status, summary) " +
						"VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run(fixture.sessionId, "toolu-late", "b2", at(900), "completed", "Background command finished");

			const after = await fw.scan(fixture.sessionId, ["time-economy"]);
			assert.equal(after.length, 1);
			assert.equal(after[0]!.status, "missing", "a new completion re-identifies the unit");
		} finally {
			await close();
			fixture.cleanup();
		}
	});
});
