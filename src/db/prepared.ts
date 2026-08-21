import type { AsyncDatabase, AsyncStatement } from "./async-db.js";

/**
 * Prepared-statement access for the async SQLite driver.
 *
 * better-sqlite3 bound `Statement`s to the connection and had to be cached
 * per-instance; the worker-thread driver instead caches prepared statements
 * by SQL string inside the worker (`async-db-worker.ts`), so on the main side
 * `prep` is just a typed passthrough to `AsyncDatabase.prepare`. Keeping the
 * `prep(db, sql)` call shape means the query layer's await migration is
 * mechanical: `prep(db, sql).all(...)` becomes `(await prep(db, sql).all(...))`.
 */
export function prep(db: AsyncDatabase, sql: string): AsyncStatement {
	return db.prepare(sql);
}