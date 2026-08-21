import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import { AsyncDatabase } from "../../src/db/async-db.js";

function tempDbPath(): string {
	return `${os.tmpdir()}/prospect-async-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

describe("AsyncDatabase worker bridge", () => {
	it("runs get/all/run against a worker thread", async () => {
		const dbPath = tempDbPath();
		const db = new AsyncDatabase(dbPath);
		try {
			await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
			const ins = db.prepare("INSERT INTO t (id, v) VALUES (?, ?)");
			const run = await ins.run(1, "hello");
			assert.equal(run.changes, 1);

			const all = (await db.prepare("SELECT * FROM t ORDER BY id").all()) as Array<Record<string, unknown>>;
			assert.equal(all.length, 1);
			assert.equal(all[0]!.v, "hello");

			const row = (await db.prepare("SELECT v FROM t WHERE id = ?").get(1)) as Record<string, unknown>;
			assert.equal(row.v, "hello");
		} finally {
			await db.close();
		}
	});

	it("transactions are exclusive: no outside stmt lands mid-transaction", async () => {
		const dbPath = tempDbPath();
		const db = new AsyncDatabase(dbPath);
		try {
			await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
			// The tx body awaits (simulating an fs/LLM yield) while holding the lock.
			const tx = db.transaction(async () => {
				await db.prepare("INSERT INTO t (id, v) VALUES (1, 'a')").run();
				await new Promise<void>((r) => setTimeout(r, 20));
			});
			// Fire the tx and concurrently an outside insert from a different async
			// context. It must wait for the tx to finish — if it landed inside,
			// its row would sit in the same transaction and could be rolled back.
			const outside = db.exec("INSERT INTO t (id, v) VALUES (99, 'outside')");
			await tx();
			await outside;
			const rows = (await db.prepare("SELECT id FROM t").all()) as Array<{ id: number }>;
			assert.deepEqual(rows.map((r) => r.id), [1, 99]);
		} finally {
			await db.close();
		}
	});

	it("transactions roll back atomically on throw", async () => {
		const dbPath = tempDbPath();
		const db = new AsyncDatabase(dbPath);
		try {
			await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
			const bad = db.transaction(async () => {
				await db.prepare("INSERT INTO t (id, v) VALUES (2, 'b')").run();
				throw new Error("boom");
			});
			await assert.rejects(() => bad());
			const count = ((await db.prepare("SELECT COUNT(*) c FROM t").get()) as { c: number }).c;
			assert.equal(count, 0);
		} finally {
			await db.close();
		}
	});

	it("deep-walks Buffer columns through the worker boundary", async () => {
		const dbPath = tempDbPath();
		const db = new AsyncDatabase(dbPath);
		try {
			await db.exec("CREATE TABLE blob (id INTEGER PRIMARY KEY, data BLOB)");
			await db.prepare("INSERT INTO blob (id, data) VALUES (1, ?)").run(new Uint8Array([1, 2, 3]));
			const row = (await db.prepare("SELECT data FROM blob WHERE id = 1").get()) as { data: number[] };
			assert.deepEqual(Array.from(row.data), [1, 2, 3]);
		} finally {
			await db.close();
		}
	});

	it("nested transactions use savepoints and commit independently", async () => {
		const dbPath = tempDbPath();
		const db = new AsyncDatabase(dbPath);
		try {
			await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");

			// Outer tx commits an inner tx and rolls back an inner savepoint; the
			// outer commits its own insert, and the savepoint rollback must not
			// undo the outer tx or the committed inner tx (better-sqlite3 nesting).
			const outer = db.transaction(async () => {
				await db.prepare("INSERT INTO t (id, v) VALUES (1, 'outer')").run();
				const inner = db.transaction(async () => {
					await db.prepare("INSERT INTO t (id, v) VALUES (2, 'committed')").run();
				});
				await inner();
				const rolled = db.transaction(async () => {
					await db.prepare("INSERT INTO t (id, v) VALUES (3, 'rolled')").run();
					throw new Error("inner rollback");
				});
				await assert.rejects(() => rolled());
			});
			await outer();

			const rows = ((await db.prepare("SELECT id, v FROM t ORDER BY id").all()) as Array<{ id: number; v: string }>);
			assert.deepEqual(rows, [
				{ id: 1, v: "outer" },
				{ id: 2, v: "committed" },
			]);
		} finally {
			await db.close();
		}
	});
});