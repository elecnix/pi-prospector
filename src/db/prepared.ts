import type Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";

/**
 * Prepared-statement cache, keyed per `Database` connection.
 *
 * better-sqlite3 `Statement`s are bound to the connection they were prepared
 * on, so the cache must be per-instance rather than module-global: a statement
 * prepared on a closed database must never be handed to a later connection
 * (tests create a fresh temp DB per case, so a module-level `Map<sql, Statement>`
 * would leak across cases). We key a WeakMap by the `Database` object, and each
 * connection lazily grows its own `Map<sql, Statement>` on first use.
 *
 * Population is lazy and every caller runs after `migrate()`, so the cache is
 * only ever filled once the schema is final — a cached statement can never
 * capture a pre-migration query plan.
 */
const statementCache = new WeakMap<Database.Database, Map<string, Statement>>();

/** Return a cached, connection-bound prepared statement, preparing on miss. */
export function prep(db: Database.Database, sql: string): Statement {
	let cache = statementCache.get(db);
	if (!cache) {
		cache = new Map();
		statementCache.set(db, cache);
	}
	let stmt = cache.get(sql);
	if (!stmt) {
		stmt = db.prepare(sql);
		cache.set(sql, stmt);
	}
	return stmt;
}
