import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { prep } from "../../src/db/prepared.js";

describe("prepared statement cache (prep)", () => {
	it("reuses the same Statement for identical SQL on the same connection", () => {
		const db = new Database(":memory:");
		const a = prep(db, "SELECT 1");
		const b = prep(db, "SELECT 1");
		assert.equal(a, b, "cache should return the identical Statement object");
		db.close();
	});

	it("keeps distinct caches per connection (no cross-DB statement leakage)", () => {
		const sql = "SELECT 1";
		const db1 = new Database(":memory:");
		const db2 = new Database(":memory:");
		const s1 = prep(db1, sql);
		const s2 = prep(db2, sql);
		assert.notEqual(s1, s2, "each connection must have its own prepared Statement");
		db1.close();
		db2.close();
	});

	it("a fresh connection never receives a statement prepared on a closed one", () => {
		const closed = new Database(":memory:");
		prep(closed, "SELECT 1");
		closed.close();

		// A new connection sharing the identical SQL must still work — it must
		// not be handed the closed connection's statement.
		const fresh = new Database(":memory:");
		const stmt = prep(fresh, "SELECT 1");
		assert.deepEqual(stmt.get(), { "1": 1 });
		fresh.close();
	});

	it("prepared statements run correctly through the cache", () => {
		const db = new Database(":memory:");
		const stmt = prep(db, "SELECT ? AS val");
		assert.deepEqual(stmt.get(42), { val: 42 });
		db.close();
	});
});
