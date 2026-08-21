/**
 * Component tests for the revive-chains analyzer, exercised end-to-end through
 * the real AnalyzerFramework and real SQLite. No real session data, no network,
 * no LLM (the analyzer is deterministic).
 *
 * These prove it plans, scans, persists a node, is idempotent on re-run,
 * anchors chains to the exact revived calls, keeps the self/delegated usage
 * split visible, counts an unmatched run id as unattributed rather than zero,
 * and proposes the prose remedy — never an install.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AsyncDatabase } from "../src/db/async-db.js";
import { tempDb } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import {
	reviveChainsAnalyzer,
	REVIVE_CHAINS_DEF,
	type ReviveChainsProperties,
} from "../../src/analyze/analyzers/revive-chains/index.js";

const PROJECT = "revive-chains-project";

let seq = 0;

interface Row {
	role: string;
	text?: string | null;
	toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
	toolResults?: Array<{
		toolCallId: string;
		toolName: string;
		isError: boolean;
		textLength: number;
		subagent?: { status: string; runId?: string };
	}>;
	usage?: Record<string, number> | null;
	costUsd?: number | null;
}

async function insertRows(db: AsyncDatabase, sessionId: string, rows: Row[]): string[]  {
	const stmt = await db.prepare(
		"INSERT INTO messages (id, session_id, source, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, usage, model, cost_usd, provider_message_id, stop_reason, error_message) " +
			"VALUES (?, ?, 'pi', ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, NULL, NULL)",
	);
	const ids: string[] = [];
	let parent: string | null = null;
	for (const r of rows) {
		const id = `rc-${sessionId}-${seq++}`;
		await stmt.run(
			id,
			sessionId,
			parent,
			new Date(1_700_000_000_000 + seq * 1000).toISOString(),
			r.role,
			r.text ?? null,
			r.toolCalls ? JSON.stringify(r.toolCalls) : null,
			r.toolResults ? JSON.stringify(r.toolResults) : null,
			r.usage ? JSON.stringify(r.usage) : null,
			r.costUsd ?? null,
			// Assistants carry their provider id so the self fold de-duplicates
			// exactly the way token-units does.
			r.role === "assistant" ? id : null,
		);
		ids.push(id);
		parent = id;
	}
	return ids;
}

/** A session in PROJECT plus its child-run artifacts, joined by project. */
async function seedSession(db: AsyncDatabase): void  {
	await db.prepare(
		"INSERT INTO sessions (id, file_path, project, source, cwd, started_at, last_line, last_modified, message_count, branch_count) " +
			"VALUES ('parent-1', '/tmp/parent-1.jsonl', ?, 'pi', '', '', 0, 0, 0, 0)",
	).run(PROJECT);
}

async function upsertRun(db: AsyncDatabase, runId: string, usage: string | null): void  {
	await db.prepare(
		"INSERT INTO subagent_runs (run_id, project, agent, task_excerpt, exit_code, error, model_attempts, usage, file_mtime, ingested_at) " +
			"VALUES (?, ?, 'general-purpose', NULL, 0, NULL, NULL, ?, 1_700_000_000_000, '2026-01-01T00:00:00.000Z') " +
			"ON CONFLICT(run_id) DO UPDATE SET usage = excluded.usage",
	).run(runId, PROJECT, usage);
}

/**
 * One revive chain of three, broken afterwards by ordinary bash traffic, plus
 * two parent turns that cost something themselves. Child run r1 has recorded
 * usage; r2's artifact row exists but records none; r3 was never ingested.
 */
const CHAIN_ROWS: Row[] = [
	{ role: "user", text: "interview the child about the design" },
	{ role: "assistant", usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.01 },
	{
		role: "assistant",
		toolCalls: [{ id: "c1", name: "subagent", arguments: {} }],
	},
	{
		role: "toolResult",
		text: "Revived async subagent from r1.",
		toolResults: [{ toolCallId: "c1", toolName: "subagent", isError: false, textLength: 30, subagent: { status: "revived", runId: "r1" } }],
	},
	{
		role: "assistant",
		toolCalls: [{ id: "c2", name: "subagent", arguments: {} }],
	},
	{
		role: "toolResult",
		text: "Revived async subagent from r2.",
		toolResults: [{ toolCallId: "c2", toolName: "subagent", isError: false, textLength: 30, subagent: { status: "revived", runId: "r2" } }],
	},
	{
		role: "assistant",
		toolCalls: [{ id: "c3", name: "subagent", arguments: {} }],
	},
	{
		role: "toolResult",
		text: "Revived async subagent from r3.",
		toolResults: [{ toolCallId: "c3", toolName: "subagent", isError: false, textLength: 30, subagent: { status: "revived", runId: "r3" } }],
	},
	{ role: "assistant", toolCalls: [{ id: "b1", name: "bash", arguments: {} }] },
	{ role: "toolResult", toolResults: [{ toolCallId: "b1", toolName: "bash", isError: false, textLength: 3 }] },
];

async function newFramework(db: AsyncDatabase) {
	const fw = new AnalyzerFramework({
		db,
		llm: createMockLLM({ fallback: "" }).caller,
		modelTiers: DEFAULT_MODEL_TIERS,
	});
	await fw.register(reviveChainsAnalyzer);
	return fw;
}

async function readProps(db: AsyncDatabase): Promise<ReviveChainsProperties> {
	const rows = (await db
		.prepare("SELECT content_json FROM analysis_nodes WHERE analyzer_id = ? ORDER BY created_at ASC, id ASC")
		.all(REVIVE_CHAINS_DEF.id)) as Array<{ content_json: string }>;
	assert.ok(rows.length >= 1, "expected a revive-chains node");
	return JSON.parse(rows[rows.length - 1]!.content_json) as ReviveChainsProperties;
}

describe("revive-chains component test", () => {
	it("detects the chain, splits self from delegated usage, and proposes the prose remedy", async () => {
		const { db, close } = await tempDb();
		try {
			seedSession(db);
			const ids = await insertRows(db, "parent-1", CHAIN_ROWS);
			await upsertRun(db, "r1", JSON.stringify({ input: 5000, output: 800, cacheRead: 200, cacheWrite: 100, cost: 0.05, turns: 2 }));
			await upsertRun(db, "r2", null);

			await (await newFramework(db)).run("parent-1", { analyzerIds: ["revive-chains"] });

			const props = await readProps(db);
			assert.equal(props.chain_count, 1);
			const [chain] = props.chains;
			assert.equal(chain!.length, 3);
			assert.equal(chain!.spawn_count, 3);
			assert.equal(chain!.redundant_spawns, 2);
			assert.deepEqual(chain!.run_ids, ["r1", "r2", "r3"]);
			assert.equal(props.redundant_spawn_count, 2);
			assert.equal(props.chain_length_histogram["3"], 1);

			// Delegated: r1 attributed with usage, r2 attributed without usage,
			// r3 never ingested → unattributed, never zero.
			assert.equal(props.usage_split.delegated.attributed_runs, 2);
			assert.equal(props.usage_split.delegated.runs_without_usage, 1);
			assert.equal(props.usage_split.delegated.unattributed_runs, 1);
			assert.equal(props.usage_split.delegated.input.value, 5000);
			assert.equal(props.usage_split.delegated.cost_usd.value, 0.05);
			assert.equal(props.usage_split.delegated.turns.value, 2);

			// Self: the parent's own single billed call, kept strictly apart.
			assert.equal(props.usage_split.self.calls, 1);
			assert.equal(props.usage_split.self.input, 1000);
			assert.equal(props.usage_split.self.output, 100);
			assert.equal(props.usage_split.self.cost_usd, 0.01);

			// The remedy is prose about a host capability, never an install.
			assert.ok(props.remedy, "a chain of three earns a proposal");
			assert.match(props.remedy!, /persistent multi-turn|intercom/);
			assert.doesNotMatch(props.remedy!, /npm:|install /i);

			// The finding walks back to the exact revived calls' carrying messages.
			const anchors = (await db
				.prepare("SELECT to_ref_id FROM analysis_edges WHERE edge_kind = 'anchors' AND to_ref_kind = 'message'")
				.all()) as Array<{ to_ref_id: string }>;
			assert.deepEqual(anchors.map((a) => a.to_ref_id).sort(), [ids[3], ids[5], ids[7]].sort());
		} finally {
			await close();
		}
	});

	it("stays a metric below the threshold and skips sessions with no orchestration traffic", async () => {
		const { db, close } = await tempDb();
		try {
			seedSession(db);
			await insertRows(db, "parent-1", [
				{ role: "user", text: "plain session" },
				{ role: "assistant", toolCalls: [{ id: "b1", name: "bash", arguments: {} }] },
				{ role: "toolResult", toolResults: [{ toolCallId: "b1", toolName: "bash", isError: false, textLength: 3 }] },
			]);

			await (await newFramework(db)).run("parent-1", { analyzerIds: ["revive-chains"] });

			const count = ((await db
				.prepare("SELECT COUNT(*) AS n FROM analysis_nodes WHERE analyzer_id = ?")
				.get(REVIVE_CHAINS_DEF.id)) as { n: number });
			assert.equal(count.n, 0, "no subagent traffic → no node");
		} finally {
			await close();
		}
	});

	it("is idempotent: a second run over unchanged inputs produces no new node", async () => {
		const { db, close } = await tempDb();
		try {
			seedSession(db);
			await insertRows(db, "parent-1", CHAIN_ROWS);
			await upsertRun(db, "r1", JSON.stringify({ input: 5000 }));

			const fw = await newFramework(db);
			await fw.run("parent-1", { analyzerIds: ["revive-chains"] });
			const afterFirst = await db
				.prepare("SELECT COUNT(*) AS n FROM analysis_nodes WHERE analyzer_id = ?")
				.get(REVIVE_CHAINS_DEF.id) as { n: number };

			await fw.run("parent-1", { analyzerIds: ["revive-chains"] });
			const afterSecond = await db
				.prepare("SELECT COUNT(*) AS n FROM analysis_nodes WHERE analyzer_id = ?")
				.get(REVIVE_CHAINS_DEF.id) as { n: number };

			assert.equal(afterSecond.n, afterFirst.n);
		} finally {
			await close();
		}
	});
});
