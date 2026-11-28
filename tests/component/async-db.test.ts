import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { AsyncDatabase, BUSY_TIMEOUT_MS } from "../../src/db/async-db.js";

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

	it("opens a file read-only: writes fail, and a missing file is an error on every call, not a new database", async () => {
		const dbPath = tempDbPath();
		const writer = new AsyncDatabase(dbPath);
		await writer.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
		await writer.close();
		const reader = new AsyncDatabase(dbPath, { readonly: true });
		try {
			assert.deepEqual(await reader.prepare("SELECT COUNT(*) AS n FROM t").get(), { n: 0 });
			await assert.rejects(reader.prepare("INSERT INTO t (id) VALUES (1)").run(), /readonly/);
		} finally {
			await reader.close();
		}

		const missing = tempDbPath();
		const absent = new AsyncDatabase(missing, { readonly: true });
		await assert.rejects(absent.prepare("SELECT 1").get(), /unable to open|does not exist/);
		await assert.rejects(absent.prepare("SELECT 1").get(), /unable to open|does not exist/);
		await absent.close();
		assert.equal(fs.existsSync(missing), false);
	});

	it("waits out another connection's write lock instead of failing with 'database is locked'", async () => {
		const dbPath = tempDbPath();
		const writer = new AsyncDatabase(dbPath);
		const second = new AsyncDatabase(dbPath);
		try {
			await writer.pragma("journal_mode = WAL");
			await writer.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
			const reader = new AsyncDatabase(dbPath, { readonly: true });
			try {
				for (const db of [writer, second, reader]) assert.deepEqual(await db.pragma("busy_timeout"), [{ timeout: BUSY_TIMEOUT_MS }]);
				// The writer holds the write lock across an await, as a sync batch does.
				let release!: () => void;
				const held = new Promise<void>((r) => (release = r));
				const tx = writer.transaction(async () => {
					await writer.prepare("INSERT INTO t (id) VALUES (1)").run();
					await held;
				})();
				await new Promise<void>((r) => setTimeout(r, 20));
				// A reader is never blocked in WAL mode, and a second writer waits for the lock.
				assert.deepEqual(await reader.prepare("SELECT COUNT(*) AS n FROM t").get(), { n: 0 });
				const waiting = second.prepare("INSERT INTO t (id) VALUES (2)").run();
				setTimeout(release, 200);
				await tx;
				assert.equal((await waiting).changes, 1);
			} finally {
				await reader.close();
			}
		} finally {
			await second.close();
			await writer.close();
		}
	});

	it("an immediate transaction takes the write lock before its body runs", async () => {
		const dbPath = tempDbPath();
		const first = new AsyncDatabase(dbPath);
		const second = new AsyncDatabase(dbPath);
		try {
			await first.pragma("journal_mode = WAL");
			await first.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
			let release!: () => void;
			const held = new Promise<void>((r) => (release = r));
			const firstTx = first.transaction(async () => {
				await first.prepare("INSERT INTO t (id) VALUES (1)").run();
				await held;
			})();
			await new Promise<void>((r) => setTimeout(r, 20));
			let bodyRan = false;
			const secondTx = second.transaction(async () => {
				bodyRan = true;
				await second.prepare("INSERT INTO t (id) VALUES (2)").run();
			}, { immediate: true })();
			// A deferred BEGIN succeeds at once while another connection writes, and
			// the body would already have run; BEGIN IMMEDIATE waits on the lock.
			await new Promise<void>((r) => setTimeout(r, 100));
			assert.equal(bodyRan, false);
			release();
			await firstTx;
			await secondTx;
			assert.equal(bodyRan, true);
			assert.deepEqual(await first.prepare("SELECT id FROM t ORDER BY id").all(), [{ id: 1 }, { id: 2 }]);
		} finally {
			await second.close();
			await first.close();
		}
	});
});
