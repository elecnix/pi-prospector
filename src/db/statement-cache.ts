/**
 * Per-connection prepared-statement cache.
 *
 * better-sqlite3 re-parses and re-plans SQL on every `db.prepare()` call, and it
 * ships no statement cache of its own (`db.cache` is always undefined). Before
 * this module, nearly every query in the db layer called `db.prepare()` per
 * invocation, so the hot paths (node/edge writes, fingerprint lookups) recompiled
 * the same statement thousands of times for a single fill run.
 *
 * A `Statement` is *bound to the connection it was prepared on* — running one
 * prepared against a different or closed database throws. So the cache is keyed
 * by the `Database` instance itself (weakly, so a closed temp database and its
 * statements are reclaimed together) and, under that, by the exact SQL text.
 * There is deliberately **no module-global SQL→Statement map**: component tests
 * create a fresh temp database per case (`tempDb()`), and a global map would hand
 * a statement from a closed connection to the next test.
 *
 * The cache is created lazily on first use and, in normal operation, only after
 * `migrate()` has run: `initializeStatementCache(db)` is the final step of
 * `migrate()`, and every command path opens a database, migrates it, *then*
 * queries. Keeping the explicit hook in `migrate()` guards the documented
 * intent that nothing is cached until the final schema is in place — a statement
 * is never compiled against pre-migration schema. (`prepare` also lazily
 * attaches a cache to a connection that skipped `migrate()`, e.g. a raw test
 * connection over an already-built database file, so it never changes
 * behaviour: it is purely an optimisation.)
 */
import type Database from "better-sqlite3";

/** Connections whose `migrate()` has completed and may cache statements. */
const initialized = new WeakSet<Database.Database>();
/** A statement cache for every `Database` we have seen, keyed by exact SQL. */
const caches = new WeakMap<Database.Database, Map<string, Database.Statement>>();

/**
 * Mark `db` ready to cache statements. Called as the last step of `migrate()`,
 * which guarantees the final schema is in place before anything is cached.
 * Idempotent; safe to call more than once on one connection.
 */
export function initializeStatementCache(db: Database.Database): void {
	if (!caches.has(db)) {
		caches.set(db, new Map());
	}
	initialized.add(db);
}

/**
 * Return a statement for `sql`, reusing a cached one when available.
 *
 * Only connections that have been through `migrate()` (and therefore carry the
 * final schema) ever store statements; a statement is never compiled against
 * pre-migration schema. A connection that skipped `migrate()` (e.g. a raw test
 * connection over an already-built database file) still works, but it prepares
 * each time and caches nothing — so this is purely an optimisation and never
 * changes behaviour.
 */
export function prepare(db: Database.Database, sql: string): Database.Statement {
	if (!initialized.has(db)) {
		return db.prepare(sql);
	}
	const cache = caches.get(db);
	if (!cache) {
		return db.prepare(sql);
	}
	let stmt = cache.get(sql);
	if (!stmt) {
		stmt = db.prepare(sql);
		cache.set(sql, stmt);
	}
	return stmt;
}
