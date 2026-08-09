import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initializeStatementCache, prepare } from "../../src/db/statement-cache.js";

describe("statement cache (per-connection prepared statements)", () => {
	it("works on an uninitialized connection but does not cache (no caching pre-migration)", () => {
		const db = new Database(":memory:");
		db.exec("CREATE TABLE t (x TEXT)");
		// No initializeStatementCache: statements still execute, but nothing is
		// cached until migrate() has run — so each prepare is a fresh statement.
		const sql = "SELECT * FROM t";
		const first = prepare(db, sql);
		const second = prepare(db, sql);
		assert.deepEqual(first.all(), []);
		assert.notStrictEqual(first, second);
		db.close();
	});

	it("returns the same statement for the same SQL on a connection", () => {
		const db = new Database(":memory:");
		initializeStatementCache(db);
		// initialize is idempotent (safe to call more than once on one connection).
		initializeStatementCache(db);
		db.exec("CREATE TABLE t (x TEXT)");
		const first = prepare(db, "SELECT * FROM t WHERE x = ?");
		const second = prepare(db, "SELECT * FROM t WHERE x = ?");
		assert.strictEqual(first, second);
		db.close();
	});

	it("does not share statements across connections", () => {
		const dbA = new Database(":memory:");
		const dbB = new Database(":memory:");
		initializeStatementCache(dbA);
		initializeStatementCache(dbB);
		dbA.exec("CREATE TABLE t (x TEXT)");
		dbB.exec("CREATE TABLE t (x TEXT)");

		const stmtA = prepare(dbA, "SELECT * FROM t");
		const stmtB = prepare(dbB, "SELECT * FROM t");
		// Keyed by connection, so each connection gets its own Statement instance,
		// and each is bound to (and only executes against) its own database.
		assert.notStrictEqual(stmtA, stmtB);
		assert.strictEqual(stmtA.database, dbA);
		assert.strictEqual(stmtB.database, dbB);

		dbA.close();
		// A closed connection's cached statement must not be served to B, and B's
		// statement must remain usable (it was never bound to the closed A).
		assert.throws(() => stmtA.all(), /not open/);
		assert.deepEqual(prepare(dbB, "SELECT * FROM t").all(), []);
		dbB.close();
	});

	it("executes identically through the cached statement", () => {
		const db = new Database(":memory:");
		initializeStatementCache(db);
		db.exec("CREATE TABLE t (x TEXT)");
		const insert = prepare(db, "INSERT INTO t (x) VALUES (?)");
		insert.run("a");
		insert.run("b");
		const rows = prepare(db, "SELECT x FROM t ORDER BY x").all<{ x: string }>();
		assert.deepEqual(rows, [{ x: "a" }, { x: "b" }]);
		db.close();
	});

	it("leaves a freshly migrated database usable (migrate initializes the cache)", async () => {
		const db = new Database(":memory:");
		// The same path every command uses: new Database then migrate().
		const { migrate } = await import("../../src/db/schema.js");
		migrate(db);
		assert.doesNotThrow(() => prepare(db, "SELECT * FROM sessions"));
		db.close();
	});
});
