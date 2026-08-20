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

	it("transactions commit and roll back", async () => {
		const dbPath = tempDbPath();
		const db = new AsyncDatabase(dbPath);
		try {
			await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
			const tx = db.transaction(async () => {
				await db.prepare("INSERT INTO t (id, v) VALUES (1, 'a')").run();
			});
			await tx();
			assert.equal(((await db.prepare("SELECT COUNT(*) c FROM t").get()) as { c: number }).c, 1);

			// Rolling back path: a throw inside the closure must not persist.
			const bad = db.transaction(async () => {
				await db.prepare("INSERT INTO t (id, v) VALUES (2, 'b')").run();
				throw new Error("boom");
			});
			await assert.rejects(() => bad());
			assert.equal(((await db.prepare("SELECT COUNT(*) c FROM t").get()) as { c: number }).c, 1);
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
});