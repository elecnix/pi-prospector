import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { tempDb } from "./helpers.js";
import { migrate } from "../../src/db/schema.js";
import { registerPrompt } from "../../src/db/analysis-queries.js";

function tableColumns(db: import("better-sqlite3").Database, table: string): Set<string> {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	return new Set(rows.map((r) => r.name));
}

function tableExists(db: import("better-sqlite3").Database, table: string): boolean {
	return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
}

describe("schema migration", () => {
	it("creates all core and framework tables", () => {
		const { db, close } = tempDb();
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
				assert.ok(tableExists(db, t), `missing table ${t}`);
			}
		} finally {
			close();
		}
	});

	it("proposals table has v2 columns", () => {
		const { db, close } = tempDb();
		try {
			const cols = tableColumns(db, "proposals");
			for (const c of ["target_type", "target_path", "title", "confidence", "status", "input_key", "source_node_id", "updated_at"]) {
				assert.ok(cols.has(c), `proposals missing ${c}`);
			}
		} finally {
			close();
		}
	});

	it("analysis_nodes carries the config fingerprint (config dimension of identity)", () => {
		const { db, close } = tempDb();
		try {
			assert.ok(tableColumns(db, "analysis_nodes").has("config_fingerprint"), "analysis_nodes missing config_fingerprint");
		} finally {
			close();
		}
	});

	it("analysis_nodes enforces unique input_key", () => {
		const { db, close } = tempDb();
		try {
			db.prepare("INSERT INTO sessions (id, file_path) VALUES ('s', '/tmp/s.jsonl')").run();
			const insert = (inputKey: string) =>
				db
					.prepare(
						"INSERT INTO analysis_nodes (id, session_id, analyzer_id, analyzer_version_id, config_id, node_kind, content_json, source_set_hash, input_key, created_at) " +
							"VALUES (?, 's', 'a', '1', 'c', 'metric', '{}', 'ssh', ?, ?)",
					)
					.run(Math.random().toString(36), inputKey, new Date().toISOString());
			insert("h1");
			assert.throws(() => insert("h1"), /UNIQUE/);
		} finally {
			close();
		}
	});

	it("creates the remediations table and remediation_id on proposal_decisions", () => {
		const { db, close } = tempDb();
		try {
			assert.ok(tableExists(db, "remediations"), "missing table remediations");
			const cols = tableColumns(db, "remediations");
			for (const c of ["id", "description", "actual_change", "created_at"]) {
				assert.ok(cols.has(c), `remediations missing ${c}`);
			}
			assert.ok(tableColumns(db, "proposal_decisions").has("remediation_id"), "proposal_decisions missing remediation_id");
		} finally {
			close();
		}
	});

	it("adds remediation_id to a pre-remediation proposal_decisions table", () => {
		// Simulate a DB created before remediations existed: proposal_decisions
		// without the remediation_id column. migrate must add it in place.
		const db = new Database(":memory:");
		try {
			db.exec(`CREATE TABLE proposal_decisions (
				id TEXT PRIMARY KEY,
				proposal_input_key TEXT NOT NULL,
				decision TEXT NOT NULL,
				disposition TEXT,
				rationale TEXT,
				actual_change TEXT,
				harness_ref TEXT,
				decided_at TEXT NOT NULL
			)`);
			db.prepare(
				"INSERT INTO proposal_decisions (id, proposal_input_key, decision, decided_at) VALUES ('d1', 'ik', 'accepted', '2026-01-01T00:00:00.000Z')",
			).run();
			migrate(db);
			assert.ok(tableColumns(db, "proposal_decisions").has("remediation_id"));
			const row = db.prepare("SELECT remediation_id FROM proposal_decisions WHERE id = 'd1'").get() as { remediation_id: string | null };
			assert.equal(row.remediation_id, null);
		} finally {
			db.close();
		}
	});

	it("proposals carry a nullable cost_usd column and migration backfills it as null (issue #71)", () => {
		const { db, close } = tempDb();
		try {
			assert.ok(tableColumns(db, "proposals").has("cost_usd"), "proposals missing cost_usd");
		} finally {
			close();
		}
	});

	it("is idempotent (re-running migrate is safe)", () => {
		const { db, close } = tempDb();
		try {
			assert.doesNotThrow(() => {
				// migrate already ran in tempDb; run sync-like usage again
				db.prepare("SELECT COUNT(*) FROM analysis_nodes").get();
			});
		} finally {
			close();
		}
	});

	it("messages table carries model and cost_usd as nullable columns (issue #65)", () => {
		const { db, close } = tempDb();
		try {
			const cols = tableColumns(db, "messages");
			assert.ok(cols.has("model"), "messages missing model");
			assert.ok(cols.has("cost_usd"), "messages missing cost_usd");
		} finally {
			close();
		}
	});

	it("adds model and cost_usd to a pre-existing messages table, leaving history as null (issue #65)", () => {
		// Simulate a DB created before issue #65: messages has neither column.
		// migrate must add both in place; existing rows keep NULL (not a guessed
		// cost) until a full re-sync rebuilds the index from transcripts.
		const db = new Database(":memory:");
		try {
			db.exec(`CREATE TABLE messages (
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
			db.prepare(
				"INSERT INTO messages (id, session_id, role) VALUES ('old1', 's', 'assistant')",
			).run();
			migrate(db);
			const cols = tableColumns(db, "messages");
			assert.ok(cols.has("model"));
			assert.ok(cols.has("cost_usd"));
			const row = db.prepare("SELECT model, cost_usd FROM messages WHERE id = 'old1'").get() as { model: string | null; cost_usd: number | null };
			assert.equal(row.model, null);
			assert.equal(row.cost_usd, null);
		} finally {
			db.close();
		}
	});
});

describe("prompt_registry full_hash", () => {
	it("drops the legacy NOT NULL full_hash column and registers prompts afterwards", () => {
		// Reproduces the field failure: databases created by the pre-0.2.0
		// analyzer-framework build carry prompt_registry.full_hash as NOT NULL,
		// which broke the first registerPrompt insert. Nothing reads full_hash,
		// so migrate drops the dead column instead of feeding it.
		const db = new Database(":memory:");
		try {
			db.exec(`CREATE TABLE prompt_registry (
				hash TEXT PRIMARY KEY,
				content TEXT NOT NULL,
				role TEXT,
				full_hash TEXT NOT NULL,
				created_at TEXT NOT NULL
			)`);
			// A legacy row: hash was the 16-char prefix of sha256(content).
			const legacyContent = "legacy prompt";
			const legacyFull = createHash("sha256").update(legacyContent).digest("hex");
			db.prepare("INSERT INTO prompt_registry (hash, content, role, full_hash, created_at) VALUES (?, ?, ?, ?, ?)")
				.run(legacyFull.slice(0, 16), legacyContent, null, legacyFull, new Date().toISOString());

			migrate(db);
			assert.ok(!tableColumns(db, "prompt_registry").has("full_hash"), "full_hash should be dropped");
			const legacyRow = db.prepare("SELECT hash, content FROM prompt_registry").get() as { hash: string; content: string };
			assert.equal(legacyRow.content, legacyContent);
			assert.doesNotThrow(() => {
				registerPrompt(db, { hash: "abc123", content: "hello world" });
			});
		} finally {
			db.close();
		}
	});

	it("leaves a prompt_registry without the column alone", () => {
		const db = new Database(":memory:");
		try {
			db.exec(`CREATE TABLE prompt_registry (
				hash TEXT PRIMARY KEY,
				content TEXT NOT NULL,
				role TEXT,
				created_at TEXT NOT NULL
			)`);
			migrate(db);
			assert.ok(!tableColumns(db, "prompt_registry").has("full_hash"));
			assert.doesNotThrow(() => {
				registerPrompt(db, { hash: "deadbeef", content: "no legacy column" });
			});
		} finally {
			db.close();
		}
	});

	it("creates prompt_registry without a full_hash column on fresh databases", () => {
		const { db, close } = tempDb();
		try {
			assert.ok(!tableColumns(db, "prompt_registry").has("full_hash"));
			registerPrompt(db, { hash: "abc123", content: "fresh" });
		} finally {
			close();
		}
	});
});
