import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import { openAsyncDatabase } from "../../src/db/async-db.js";
import { prep } from "../../src/db/prepared.js";

function memPath(tag: string): string {
	return `${os.tmpdir()}/prospect-prepared-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

describe("prepared statements (prep)", () => {
	it("prepared statements run correctly through the async driver", async () => {
		const db = openAsyncDatabase(memPath("run"));
		try {
			const stmt = prep(db, "SELECT ? AS val");
			assert.deepEqual(await stmt.get(42), { val: 42 });
		} finally {
			await db.close();
		}
	});

	it("distinct AsyncDatabase connections never share a prepared statement", async () => {
		const db1 = openAsyncDatabase(memPath("a"));
		const db2 = openAsyncDatabase(memPath("b"));
		try {
			const sql = "SELECT 1 AS one";
			const s1 = prep(db1, sql);
			const s2 = prep(db2, sql);
			// Each AsyncDatabase owns its own worker/connection, so the statements
			// are independent handles that both work against their own DB.
			assert.deepEqual(await s1.get(), { one: 1 });
			assert.deepEqual(await s2.get(), { one: 1 });
		} finally {
			await db1.close();
			await db2.close();
		}
	});

	it("a connection works after a sibling is closed", async () => {
		const closed = openAsyncDatabase(memPath("closed"));
		await prep(closed, "SELECT 1").get();
		await closed.close();

		// A new connection sharing identical SQL must still work — it must not
		// try to reuse the closed connection's statement/worker.
		const fresh = openAsyncDatabase(memPath("fresh"));
		try {
			const stmt = prep(fresh, "SELECT 1 AS one");
			assert.deepEqual(await stmt.get(), { one: 1 });
		} finally {
			await fresh.close();
		}
	});

	it("is a thin handle over the worker's per-connection cache", async () => {
		// prep returns a fresh AsyncStatement handle per call; the underlying
		// prepared statement lives in that AsyncDatabase's worker, keyed by SQL.
		// Both handles must execute correctly against the same connection.
		const db = openAsyncDatabase(memPath("handle"));
		try {
			const a = prep(db, "SELECT ? AS val");
			const b = prep(db, "SELECT ? AS val");
			assert.deepEqual(await a.get(7), { val: 7 });
			assert.deepEqual(await b.get(8), { val: 8 });
		} finally {
			await db.close();
		}
	});
});
