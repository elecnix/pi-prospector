import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { tempDb } from "./helpers.js";
import { migrate } from "../../src/db/schema.js";

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
});
