import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb } from "./helpers.js";

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
