/**
 * Component tests for the failure-modes analyzer, exercised end-to-end through
 * the real AnalyzerFramework and real SQLite. No real session data, no network,
 * no LLM (the analyzer is deterministic).
 *
 * These prove it plans, scans, persists a node, is idempotent, materialises
 * `extension` proposals into the proposal store, anchors findings to the exact
 * failing turns, states its own coverage rather than reading an unfilled column
 * as "nothing went wrong", and re-identifies when a re-sync fills that column in.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AsyncDatabase } from "../../src/db/async-db.js";
import { tempDb, insertSession } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import {
	failureModesAnalyzer,
	FAILURE_MODES_DEF,
	type FailureModesProperties,
} from "../../src/analyze/analyzers/failure-modes/index.js";
import { curatedPackages } from "../../src/analyze/analyzers/failure-modes/classes.js";

let seq = 0;

interface Row {
	role: string;
	text?: string | null;
	toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
	toolResults?: Array<{ toolCallId: string; toolName: string; isError: boolean; textLength: number }>;
	stopReason?: string | null;
	errorMessage?: string | null;
	costUsd?: number | null;
	id?: string;
}

/** Insert messages carrying the failure columns the shared helper predates. */
async function insertRows(db: AsyncDatabase, sessionId: string, rows: Row[]): Promise<string[]> {
	const stmt = await db.prepare(
		"INSERT INTO messages (id, session_id, source, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, model, cost_usd, stop_reason, error_message) " +
			"VALUES (?, ?, 'pi', ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)",
	);
	const ids: string[] = [];
	let parent: string | null = null;
	for (const r of rows) {
		const id = r.id ?? `fm-${sessionId}-${seq++}`;
		await stmt.run(
			id,
			sessionId,
			parent,
			new Date(1_700_000_000_000 + seq * 1000).toISOString(),
			r.role,
			r.text ?? null,
			r.toolCalls ? JSON.stringify(r.toolCalls) : null,
			r.toolResults ? JSON.stringify(r.toolResults) : null,
			r.costUsd ?? null,
			r.stopReason ?? null,
			r.errorMessage ?? null,
		);
		ids.push(id);
		parent = id;
	}
	return ids;
}

async function newFramework(db: AsyncDatabase, configOverrides?: Record<string, Record<string, unknown>>) {
	const fw = new AnalyzerFramework({
		db,
		llm: createMockLLM({ fallback: "" }).caller,
		modelTiers: DEFAULT_MODEL_TIERS,
		configOverrides,
	});
	await fw.register(failureModesAnalyzer);
	return fw;
}

async function readNode(db: AsyncDatabase): Promise<{ row: Record<string, unknown>; props: FailureModesProperties }> {
	const rows = (await db
		.prepare("SELECT * FROM analysis_nodes WHERE analyzer_id = ? ORDER BY created_at ASC, id ASC")
		.all(FAILURE_MODES_DEF.id)) as Array<Record<string, unknown>>;
	assert.ok(rows.length >= 1, "expected at least one failure-modes node");
	const row = rows[rows.length - 1]!;
	return { row, props: JSON.parse(row["content_json"] as string) as FailureModesProperties };
}

/** A settings file with a known package list, so the test never reads the developer's. */
function settingsWith(packages: unknown[]): string {
	const file = path.join(os.tmpdir(), `prospect-fm-settings-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
	fs.writeFileSync(file, JSON.stringify({ packages }));
	return file;
}

/**
 * Point the analyzer at a known settings file for the duration of `fn`.
 *
 * `await`ed, not merely called: the analyzer reads the file while the run is in
 * flight, so restoring the environment when `fn` *returns its promise* would put
 * it back before anything had read it — and the test would silently fall through
 * to the developer's own installed packages.
 */
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

const THREE_RATE_LIMITS: Row[] = [
	{ role: "user", text: "do the thing" },
	{ role: "assistant", stopReason: "error", errorMessage: "429: rate limit exceeded", costUsd: 0.01 },
	{ role: "assistant", stopReason: "error", errorMessage: "429: rate limit exceeded", costUsd: 0.02 },
	{ role: "assistant", stopReason: "error", errorMessage: "429: rate limit exceeded", costUsd: null },
];

describe("failure-modes component test", () => {
	it("detects failed generations, prices them, and proposes a verified extension", async () => {
		const { db, close } = await tempDb();
		const settings = settingsWith([]);
		try {
			await insertSession(db, "s1");
			const ids = await insertRows(db, "s1", THREE_RATE_LIMITS);

			await withSettings(settings, async () => (await newFramework(db)).run("s1", { analyzerIds: ["failure-modes"] }));

			const { row, props } = await readNode(db);
			assert.equal(row["node_kind"], "proposal");
			assert.equal(props.turn_failure_count, 3);
			assert.equal(props.assistant_turn_count, 3);
			assert.equal(props.turn_failure_capture, "present");
			assert.equal(props.installed_check, "performed");

			// Two of three priced: the total is the priced subset, and the coverage
			// counts say so. A third of the cost is genuinely unknown, not zero.
			assert.equal(props.failure_cost_usd, 0.03);
			assert.equal(props.priced_failure_count, 2);
			assert.equal(props.unpriced_failure_count, 1);

			const [proposal] = props.improvement_proposals;
			assert.equal(proposal!.target_type, "extension");
			assert.ok(curatedPackages().includes(proposal!.target_path!.slice("npm:".length)));

			// The finding walks back to the exact turns that failed.
			const anchors = (await db
				.prepare("SELECT to_ref_id FROM analysis_edges WHERE edge_kind = 'anchors' AND to_ref_kind = 'message'")
				.all()) as Array<{ to_ref_id: string }>;
			assert.deepEqual(anchors.map((a) => a.to_ref_id).sort(), ids.slice(1).sort());
		} finally {
			fs.unlinkSync(settings);
			await close();
		}
	});

	it("materialises the extension proposal into the proposal store with its package spec", async () => {
		const { db, close } = await tempDb();
		const settings = settingsWith([]);
		try {
			await insertSession(db, "s1");
			await insertRows(db, "s1", THREE_RATE_LIMITS);
			await withSettings(settings, async () => (await newFramework(db)).run("s1", { analyzerIds: ["failure-modes"] }));

			const proposals = (await db
				.prepare("SELECT target_type, target_path, severity, title FROM proposals")
				.all()) as Array<{ target_type: string; target_path: string | null; severity: string; title: string }>;
			assert.equal(proposals.length, 1);
			assert.equal(proposals[0]!.target_type, "extension");
			assert.match(proposals[0]!.target_path!, /^npm:/);
			assert.equal(proposals[0]!.severity, "waste");
		} finally {
			fs.unlinkSync(settings);
			await close();
		}
	});

	it("does not recommend a package the host already has", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertRows(db, "s1", THREE_RATE_LIMITS);

			// Every package the catalogue knows is installed, so the only honest
			// answer left is the remedy that is not a package.
			const settings = settingsWith(curatedPackages().map((p) => `npm:${p}`));
			try {
				await withSettings(settings, async () => (await newFramework(db)).run("s1", { analyzerIds: ["failure-modes"] }));
			} finally {
				fs.unlinkSync(settings);
			}

			const { props } = await readNode(db);
			const [proposal] = props.improvement_proposals;
			assert.ok(proposal, "the measurement survives even when there is nothing to install");
			assert.notEqual(proposal!.target_type, "extension");
		} finally {
			await close();
		}
	});

	it("keeps the diagnosis but drops every package pointer when extensions are turned off", async () => {
		const { db, close } = await tempDb();
		const settings = settingsWith([]);
		try {
			await insertSession(db, "s1");
			await insertRows(db, "s1", THREE_RATE_LIMITS);
			await withSettings(settings, async () =>
				(await newFramework(db, { "failure-modes": { recommendExtensions: false } })).run("s1", { analyzerIds: ["failure-modes"] }),
			);

			const { props } = await readNode(db);
			assert.equal(props.turn_failure_count, 3);
			const [proposal] = props.improvement_proposals;
			assert.notEqual(proposal!.target_type, "extension");
			assert.ok(!JSON.stringify(props.improvement_proposals).includes("npm:"));
		} finally {
			fs.unlinkSync(settings);
			await close();
		}
	});

	it("says the capture is absent rather than reporting a clean session", async () => {
		const { db, close } = await tempDb();
		const settings = settingsWith([]);
		try {
			await insertSession(db, "s1");
			// Rows as an older sync wrote them: no stop reason at all.
			await insertRows(db, "s1", [
				{ role: "user", text: "hi" },
				{ role: "assistant", text: "ok" },
			]);
			await withSettings(settings, async () => (await newFramework(db)).run("s1", { analyzerIds: ["failure-modes"] }));

			const { props } = await readNode(db);
			assert.equal(props.turn_failure_capture, "absent");
			assert.equal(props.turn_failure_count, 0);
		} finally {
			fs.unlinkSync(settings);
			await close();
		}
	});

	it("is idempotent: a second run produces no second node", async () => {
		const { db, close } = await tempDb();
		const settings = settingsWith([]);
		try {
			await insertSession(db, "s1");
			await insertRows(db, "s1", THREE_RATE_LIMITS);
			await withSettings(settings, async () => {
				await (await newFramework(db)).run("s1", { analyzerIds: ["failure-modes"] });
				await (await newFramework(db)).run("s1", { analyzerIds: ["failure-modes"] });
			});
			const count = (
				await db.prepare("SELECT COUNT(*) c FROM analysis_nodes WHERE analyzer_id = ?").get(FAILURE_MODES_DEF.id) as { c: number }
			).c;
			assert.equal(count, 1);
		} finally {
			fs.unlinkSync(settings);
			await close();
		}
	});

	it("re-identifies when a re-sync fills in error text the first pass never saw", async () => {
		const { db, close } = await tempDb();
		const settings = settingsWith([]);
		try {
			await insertSession(db, "s1");
			const ids = await insertRows(db, "s1", [
				{ role: "user", text: "go" },
				{ role: "assistant", text: "" },
				{ role: "assistant", text: "" },
				{ role: "assistant", text: "" },
			]);
			await withSettings(settings, async () => (await newFramework(db)).run("s1", { analyzerIds: ["failure-modes"] }));
			assert.equal((await readNode(db)).props.turn_failure_count, 0);

			// The message ids are unchanged, so a source set of ids alone would call
			// this unit `current` and keep serving the empty conclusion.
			const upd = await db.prepare("UPDATE messages SET stop_reason = 'error', error_message = ? WHERE id = ?");
			for (const id of ids.slice(1)) upd.run("429: rate limit exceeded", id);

			await withSettings(settings, async () => (await newFramework(db)).run("s1", { analyzerIds: ["failure-modes"] }));
			assert.equal((await readNode(db)).props.turn_failure_count, 3);
		} finally {
			fs.unlinkSync(settings);
			await close();
		}
	});

	it("marks nodes stale for the config reason once a recommended package is installed", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertRows(db, "s1", THREE_RATE_LIMITS);

			const before = settingsWith([]);
			let recommended: string;
			try {
				await withSettings(before, async () => (await newFramework(db)).run("s1", { analyzerIds: ["failure-modes"] }));
				recommended = (await readNode(db)).props.improvement_proposals[0]!.target_path!;
			} finally {
				fs.unlinkSync(before);
			}

			const after = settingsWith([recommended]);
			try {
				const scan = await withSettings(after, async () => (await newFramework(db)).scan("s1", ["failure-modes"]));
				assert.ok(
					scan.some((u) => u.status === "stale" && u.reasons?.includes("config")),
					"installing what was recommended is a config change, not a silent no-op",
				);
			} finally {
				fs.unlinkSync(after);
			}
		} finally {
			await close();
		}
	});

	it("classifies failed tool calls per tool, and never stores the raw error text", async () => {
		const { db, close } = await tempDb();
		const settings = settingsWith([]);
		try {
			await insertSession(db, "s1");
			const rows: Row[] = [{ role: "user", text: "go" }];
			for (let i = 0; i < 3; i++) {
				rows.push({
					role: "assistant",
					stopReason: "toolUse",
					toolCalls: [{ id: `c${i}`, name: "bash", arguments: { command: "cat /etc/shadow" } }],
				});
				rows.push({
					role: "toolResult",
					text: "cat: /etc/shadow: Permission denied (user private-name-here)",
					toolResults: [{ toolCallId: `c${i}`, toolName: "bash", isError: true, textLength: 60 }],
				});
			}
			await insertRows(db, "s1", rows);
			await withSettings(settings, async () => (await newFramework(db)).run("s1", { analyzerIds: ["failure-modes"] }));

			const { props } = await readNode(db);
			assert.equal(props.tool_failure_count, 3);
			assert.equal(props.tool_call_count, 3);
			const group = props.groups.find((g) => g.class_id === "permission-denied");
			assert.ok(group, "expected a permission-denied group");
			assert.equal(group!.tool, "bash");
			assert.ok(!JSON.stringify(props).includes("private-name-here"), "host error text must never reach the graph");
		} finally {
			fs.unlinkSync(settings);
			await close();
		}
	});

	it("records an abort without proposing anything about it", async () => {
		const { db, close } = await tempDb();
		const settings = settingsWith([]);
		try {
			await insertSession(db, "s1");
			await insertRows(db, "s1", [
				{ role: "user", text: "go" },
				{ role: "assistant", stopReason: "aborted", errorMessage: "This operation was aborted" },
				{ role: "assistant", stopReason: "aborted", errorMessage: "This operation was aborted" },
				{ role: "assistant", stopReason: "aborted", errorMessage: "This operation was aborted" },
			]);
			await withSettings(settings, async () => (await newFramework(db)).run("s1", { analyzerIds: ["failure-modes"] }));

			const { row, props } = await readNode(db);
			assert.equal(props.turn_failure_count, 3, "an abort is still counted");
			assert.deepEqual(props.improvement_proposals, [], "but there is nothing to fix");
			assert.equal(row["node_kind"], "metric");
		} finally {
			fs.unlinkSync(settings);
			await close();
		}
	});
});
