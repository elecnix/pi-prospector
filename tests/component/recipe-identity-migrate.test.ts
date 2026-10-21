/**
 * Component tests: the recipe-identity migration.
 *
 * `analysis_nodes.input_key` was unique across every row, retracted ones
 * included. A retracted node keeps its recipe reserved, so the recomputation
 * DESIGN.md describes — a retracted node is absent from scanning, so its unit
 * classifies `missing` and is recomputed — collided with the tombstone of the
 * node it replaces. The insert lost the unique violation, the framework read it
 * as a peer that had already done the same work, and the unit stayed missing
 * forever.
 *
 * The uniqueness now covers the live rows only, which means a database created
 * before the change has to be rebuilt: SQLite cannot express a partial UNIQUE
 * constraint on a column, so the constraint becomes a partial unique index and
 * the table is copied into a new one.
 *
 * These tests build the old shape by hand, migrate it, and check that the rows
 * survive, that the recipe is free again once a node is retracted, and that the
 * edge table's foreign key still points at the rebuilt table.
 *
 * Real SQLite (temp file), hand-written synthetic rows, no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession } from "./helpers.js";
import { migrate } from "../../src/db/schema.js";
import { NOT_MUTED_LIVE, NOT_REVISED_LIVE } from "../../src/db/current-generation.js";

type Db = Awaited<ReturnType<typeof tempDb>>["db"];

/**
 * Rebuild `analysis_nodes` with the old table-level UNIQUE, the shape a
 * database created before the change has.
 *
 * The views are dropped and recreated around the rebuild, because SQLite
 * refuses to drop a table a view reads. They end up as a real pre-migration
 * database has them, so the migration runs with the views in place.
 *
 * The edge table is rebuilt too, so its foreign key names `analysis_nodes`
 * the way it does in a database from before the change. (Renaming
 * `analysis_nodes` would rewrite that foreign key to name the renamed table,
 * which is the hazard the migration has to avoid.)
 */
async function downgradeToTableUnique(db: Db): Promise<void> {
	await db.exec("DROP VIEW IF EXISTS live_nodes");
	await db.exec("DROP VIEW IF EXISTS current_nodes");
	await db.exec(`
		CREATE TABLE analysis_edges_current (
			id TEXT PRIMARY KEY,
			from_node_id TEXT NOT NULL,
			to_ref_kind TEXT NOT NULL,
			to_ref_id TEXT NOT NULL,
			edge_kind TEXT NOT NULL,
			ordinal INTEGER NOT NULL DEFAULT 0,
			FOREIGN KEY (from_node_id) REFERENCES analysis_nodes(id)
		);
		INSERT INTO analysis_edges_current SELECT * FROM analysis_edges;
		DROP TABLE analysis_edges;
		ALTER TABLE analysis_edges_current RENAME TO analysis_edges;
	`);
	await db.exec(`
		CREATE TABLE analysis_nodes_current (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			analyzer_id TEXT NOT NULL,
			analyzer_version_id TEXT NOT NULL,
			config_id TEXT NOT NULL,
			run_id TEXT,
			node_kind TEXT NOT NULL,
			content_json TEXT NOT NULL,
			source_set_hash TEXT NOT NULL,
			input_key TEXT NOT NULL UNIQUE,
			output_key TEXT NOT NULL DEFAULT '',
			config_fingerprint TEXT NOT NULL DEFAULT '',
			model_used TEXT,
			cost_usd REAL,
			tokens_used INTEGER,
			input_tokens INTEGER,
			cached_input_tokens INTEGER,
			output_tokens INTEGER,
			duration_ms INTEGER,
			created_at TEXT NOT NULL,
			retracted_at TEXT,
			retracted_by_run TEXT,
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		);
		INSERT INTO analysis_nodes_current SELECT * FROM analysis_nodes;
		DROP TABLE analysis_nodes;
		ALTER TABLE analysis_nodes_current RENAME TO analysis_nodes;
	`);
	// Put the views back, the way a database from before the change has them.
	await db.exec("CREATE VIEW live_nodes AS SELECT * FROM analysis_nodes WHERE retracted_at IS NULL");
	await db.exec(`CREATE VIEW current_nodes AS SELECT * FROM live_nodes n WHERE ${NOT_REVISED_LIVE} AND ${NOT_MUTED_LIVE}`);
}

/** Insert a node with the given recipe. */
async function insertNode(
	db: Db,
	id: string,
	sessionId: string,
	inputKey: string,
	createdAt: string,
	retractedAt: string | null = null,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO analysis_nodes (id, session_id, analyzer_id, analyzer_version_id, config_id,
				node_kind, content_json, source_set_hash, input_key, output_key, config_fingerprint, created_at, retracted_at)
			 VALUES (?, ?, 'a', 'v', 'c', 'metric', '{}', 'sh', ?, ?, 'fp', ?, ?)`,
		)
		.run(id, sessionId, inputKey, `ok-${id}`, createdAt, retractedAt);
}

describe("the recipe-identity migration", () => {
	it("keeps the rows and frees the recipe of a retracted node", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await downgradeToTableUnique(db);
			await insertNode(db, "n1", "s1", "ik-1", "2030-01-01T00:00:00.000Z");
			await insertNode(db, "n2", "s1", "ik-2", "2030-01-01T00:01:00.000Z", "2030-01-02T00:00:00.000Z");

			// Before the migration the recipe of the retracted node is still taken.
			await assert.rejects(
				db
					.prepare(
						`INSERT INTO analysis_nodes (id, session_id, analyzer_id, analyzer_version_id, config_id,
							node_kind, content_json, source_set_hash, input_key, output_key, config_fingerprint, created_at)
						VALUES ('n3', 's1', 'a', 'v', 'c', 'metric', '{}', 'sh', 'ik-2', 'ok-n3', 'fp', '2030-01-03T00:00:00.000Z')`,
					)
					.run(),
				"the old table-level UNIQUE still holds the recipe",
			);

			await migrate(db);

			// The rows survived the rebuild.
			const rows = (await db.prepare("SELECT id FROM analysis_nodes ORDER BY id").all()) as Array<{ id: string }>;
			assert.deepEqual(rows.map((r) => r.id), ["n1", "n2"], "both nodes survived the migration");

			// The recipe of the retracted node is free again, so the unit can be
			// recomputed — the behaviour DESIGN.md describes.
			await insertNode(db, "n3", "s1", "ik-2", "2030-01-03T00:00:00.000Z");
			const after = (await db.prepare("SELECT id FROM analysis_nodes WHERE id = 'n3'").all()) as Array<{ id: string }>;
			assert.equal(after.length, 1, "the recipe of a retracted node can be used again");
		} finally {
			await close();
		}
	});

	it("leaves the edge table's foreign key pointing at the rebuilt table", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await downgradeToTableUnique(db);
			await insertNode(db, "n1", "s1", "ik-1", "2030-01-01T00:00:00.000Z");
			await db
				.prepare(
					`INSERT INTO analysis_edges (id, from_node_id, to_ref_kind, to_ref_id, edge_kind, ordinal)
					 VALUES ('e1', 'n1', 'session', 's1', 'anchors', 0)`,
				)
				.run();

			await migrate(db);

			// The edge still resolves, and a new edge can be written: the foreign
			// key names the rebuilt table, not the one the rebuild dropped.
			const edges = (await db.prepare("SELECT id FROM analysis_edges").all()) as Array<{ id: string }>;
			assert.deepEqual(edges.map((e) => e.id), ["e1"], "the edge survived the migration");
			await db
				.prepare(
					`INSERT INTO analysis_edges (id, from_node_id, to_ref_kind, to_ref_id, edge_kind, ordinal)
					 VALUES ('e2', 'n1', 'session', 's1', 'anchors', 1)`,
				)
				.run();
			const after = (await db.prepare("SELECT id FROM analysis_edges ORDER BY id").all()) as Array<{ id: string }>;
			assert.deepEqual(after.map((e) => e.id), ["e1", "e2"], "a new edge can be written after the migration");

			// The views are back and read the rebuilt table: a real database
			// migrates with them in place.
			const live = (await db.prepare("SELECT id FROM live_nodes").all()) as Array<{ id: string }>;
			assert.deepEqual(live.map((n) => n.id), ["n1"], "the live view reads the rebuilt table");
			const current = (await db.prepare("SELECT id FROM current_nodes").all()) as Array<{ id: string }>;
			assert.deepEqual(current.map((n) => n.id), ["n1"], "the current view reads the rebuilt table");
		} finally {
			await close();
		}
	});
});
