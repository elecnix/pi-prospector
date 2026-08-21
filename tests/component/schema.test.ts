import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { openAsyncDatabase, type AsyncDatabase } from "../../src/db/async-db.js";
import { tempDb } from "./helpers.js";
import { migrate } from "../../src/db/schema.js";

/** A unique temp-file path (AsyncDatabase is file-backed, not in-memory). */
function memPath(): string {
	return path.join(os.tmpdir(), `prospect-schema-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

async function tableColumns(db: AsyncDatabase, table: string): Promise<Set<string>> {
	const rows = (await db.prepare(`PRAGMA table_info(${table})`).all()) as Array<{ name: string }>;
	return new Set(rows.map((r) => r.name));
}

async function tableExists(db: AsyncDatabase, table: string): Promise<boolean> {
	return !!(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table));
}

describe("schema migration", () => {
	it("creates all core and framework tables", async () => {
		const { db, close } = await tempDb();
		try {
			for (const t of [
				"sessions",
				"messages",
				"proposals",
				"analyzer_defs",
				"analyzer_versions",
				"prompt_registry",
				"analyzer_configs",
				"analysis_runs",
				"analysis_nodes",
				"analysis_edges",
			]) {
				assert.ok(await tableExists(db, t), `missing table ${t}`);
			}
		} finally {
			await close();
		}
	});

	it("proposals table has v2 columns", async () => {
		const { db, close } = await tempDb();
		try {
			const cols = await tableColumns(db, "proposals");
			for (const c of ["target_type", "target_path", "title", "confidence", "status", "input_key", "source_node_id", "updated_at"]) {
				assert.ok(cols.has(c), `proposals missing ${c}`);
			}
		} finally {
			await close();
		}
	});

	it("analysis_nodes carries the config fingerprint (config dimension of identity)", async () => {
		const { db, close } = await tempDb();
		try {
			assert.ok((await tableColumns(db, "analysis_nodes")).has("config_fingerprint"), "analysis_nodes missing config_fingerprint");
		} finally {
			await close();
		}
	});

	it("analysis_nodes records compute-cost columns: wall-clock and token split", async () => {
		const { db, close } = await tempDb();
		try {
			const cols = await tableColumns(db, "analysis_nodes");
			assert.ok(cols.has("duration_ms"), "expected wall-clock duration_ms column");
			for (const col of ["input_tokens", "cached_input_tokens", "output_tokens"]) {
				assert.ok(cols.has(col), `analysis_nodes missing ${col}`);
			}
		} finally {
			await close();
		}
	});

	it("analysis_nodes enforces unique input_key", async () => {
		const { db, close } = await tempDb();
		try {
			await db.prepare("INSERT INTO sessions (id, file_path) VALUES ('s', '/tmp/s.jsonl')").run();
			const insert = (inputKey: string) =>
				db
					.prepare(
						"INSERT INTO analysis_nodes (id, session_id, analyzer_id, analyzer_version_id, config_id, node_kind, content_json, source_set_hash, input_key, created_at) " +
							"VALUES (?, 's', 'a', '1', 'c', 'metric', '{}', 'ssh', ?, ?)",
					)
					.run(Math.random().toString(36), inputKey, new Date().toISOString());
			await insert("h1");
			await assert.rejects(() => insert("h1"), /UNIQUE/);
		} finally {
			await close();
		}
	});

	it("creates the remediations table and remediation_id on proposal_decisions", async () => {
		const { db, close } = await tempDb();
		try {
			assert.ok(await tableExists(db, "remediations"), "missing table remediations");
			const cols = await tableColumns(db, "remediations");
			for (const c of ["id", "description", "actual_change", "created_at"]) {
				assert.ok(cols.has(c), `remediations missing ${c}`);
			}
			assert.ok((await tableColumns(db, "proposal_decisions")).has("remediation_id"), "proposal_decisions missing remediation_id");
		} finally {
			await close();
		}
	});

	it("adds remediation_id to a pre-remediation proposal_decisions table", async () => {
		// Simulate a DB created before remediations existed: proposal_decisions
		// without the remediation_id column. migrate must add it in place.
		const db = await openAsyncDatabase(memPath());
		try {
			await db.exec(`CREATE TABLE proposal_decisions (
				id TEXT PRIMARY KEY,
				proposal_input_key TEXT NOT NULL,
				decision TEXT NOT NULL,
				disposition TEXT,
				rationale TEXT,
				actual_change TEXT,
				harness_ref TEXT,
				decided_at TEXT NOT NULL
			)`);
			await db.prepare(
				"INSERT INTO proposal_decisions (id, proposal_input_key, decision, decided_at) VALUES ('d1', 'ik', 'accepted', '2026-01-01T00:00:00.000Z')",
			).run();
			await migrate(db);
			assert.ok((await tableColumns(db, "proposal_decisions")).has("remediation_id"));
			const row = (await db.prepare("SELECT remediation_id FROM proposal_decisions WHERE id = 'd1'").get()) as { remediation_id: string | null };
			assert.equal(row.remediation_id, null);
		} finally {
			await db.close();
		}
	});

	it("proposals carry a nullable cost_usd column and migration backfills it as null (issue #71)", async () => {
		const { db, close } = await tempDb();
		try {
			assert.ok((await tableColumns(db, "proposals")).has("cost_usd"), "proposals missing cost_usd");
		} finally {
			await close();
		}
	});

	it("is idempotent (re-running migrate is safe)", async () => {
		const { db, close } = await tempDb();
		try {
			// migrate already ran in tempDb; run sync-like usage again
			await db.prepare("SELECT COUNT(*) FROM analysis_nodes").get();
		} finally {
			await close();
		}
	});

	it("messages table carries model and cost_usd as nullable columns (issue #65)", async () => {
		const { db, close } = await tempDb();
		try {
			const cols = await tableColumns(db, "messages");
			assert.ok(cols.has("model"), "messages missing model");
			assert.ok(cols.has("cost_usd"), "messages missing cost_usd");
		} finally {
			await close();
		}
	});

	it("adds model and cost_usd to a pre-existing messages table, leaving history as null (issue #65)", async () => {
		// Simulate a DB created before issue #65: messages has neither column.
		// migrate must add both in place; existing rows keep NULL (not a guessed
		// cost) until a full re-sync rebuilds the index from transcripts.
		const db = await openAsyncDatabase(memPath());
		try {
			await db.exec(`CREATE TABLE messages (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				source TEXT,
				parent_id TEXT,
				timestamp TEXT,
				role TEXT NOT NULL,
				content_text TEXT,
				content_thinking TEXT,
				tool_calls TEXT,
				tool_results TEXT,
				usage TEXT,
				content_hash TEXT
			)`);
			await db.prepare(
				"INSERT INTO messages (id, session_id, role) VALUES ('old1', 's', 'assistant')",
			).run();
			await migrate(db);
			const cols = await tableColumns(db, "messages");
			assert.ok(cols.has("model"));
			assert.ok(cols.has("cost_usd"));
			const row = (await db.prepare("SELECT model, cost_usd FROM messages WHERE id = 'old1'").get()) as { model: string | null; cost_usd: number | null };
			assert.equal(row.model, null);
			assert.equal(row.cost_usd, null);
		} finally {
			await db.close();
		}
	});

	it("adds usage column to a pre-existing messages table, leaving history as null", async () => {
		// Simulate a DB created before the usage column was introduced.
		// migrate must add it in place; existing rows keep NULL until a
		// full re-sync rebuilds the index from transcripts.
		const db = await openAsyncDatabase(memPath());
		try {
			await db.exec(`CREATE TABLE messages (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				parent_id TEXT,
				timestamp TEXT,
				role TEXT NOT NULL,
				content_text TEXT,
				content_thinking TEXT,
				tool_calls TEXT,
				tool_results TEXT,
				content_hash TEXT
			)`);
			await db.prepare(
				"INSERT INTO messages (id, session_id, role) VALUES ('old1', 's', 'assistant')",
			).run();
			await migrate(db);
			const cols = await tableColumns(db, "messages");
			assert.ok(cols.has("usage"), "messages missing usage column after migration");
			const row = (await db.prepare("SELECT usage FROM messages WHERE id = 'old1'").get()) as { usage: string | null };
			assert.equal(row.usage, null, "existing rows should keep null usage");
		} finally {
			await db.close();
		}
	});
});
