import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import type { RunResult } from "better-sqlite3";

/**
 * Async SQLite driver backed by a worker thread.
 *
 * better-sqlite3 is a synchronous-only C binding: a statement run on the main
 * thread blocks pi's single-threaded event loop (the freeze /prospect-sync and
 * /prospect-analyze caused). There is no genuinely-async sqlite driver for
 * Node with better-sqlite3's ergonomics — libsql's local `file:` mode wraps the
 * sync engine and still blocks. The sound fix is to move sqlite *off* the main
 * thread: this module owns a `node:worker_threads` Worker that runs every
 * statement on its own better-sqlite3 connection, exposing an `await`-based
 * API. The main thread stays free to serve the TUI while a long sync/analyze
 * runs. (See `scripts/async-probe.mjs`: a worker-backed write leaves the event
 * loop free while the same work on the main thread stops it entirely.)
 *
 * Concurrency is single-flight:
 *  - A per-`AsyncDatabase` promise-chain mutex serialises normal invokes.
 *  - `transaction()` holds that mutex for the *whole* body, so no outside
 *    statement can land between BEGIN and COMMIT/ROLLBACK (better-sqlite3's
 *    sync transactions never needed this because nothing else could run).
 *    Statement calls made from inside the transaction body are tagged with an
 *    AsyncLocalStorage context and bypass the outer mutex — the transaction
 *    already holds it — so a body that awaits fs or an LLM call cannot deadlock
 *    against itself while still excluding concurrent writers.
 */

interface WorkerMsg {
	id: number;
	op: string;
	sql?: string;
	params?: unknown;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
}

const IN_TX = new AsyncLocalStorage<boolean>();

export class AsyncStatement {
	#db: AsyncDatabase;
	#sql: string;

	constructor(db: AsyncDatabase, sql: string) {
		this.#db = db;
		this.#sql = sql;
	}

	get sql(): string {
		return this.#sql;
	}

	/** Run and return the first row (or undefined). */
	get(...params: unknown[]): Promise<unknown> {
		return this.#db.invoke("get", this.#sql, params);
	}

	/** Run and return all rows. */
	all(...params: unknown[]): Promise<unknown[]> {
		return this.#db.invoke("all", this.#sql, params) as Promise<unknown[]>;
	}

	/** Run with no result. */
	run(...params: unknown[]): Promise<RunResult> {
		return this.#db.invoke("run", this.#sql, params) as Promise<RunResult>;
	}
}

export class AsyncDatabase {
	#worker: Worker;
	#nextId = 0;
	#pending = new Map<number, Pending>();
	/** Single-flight promise chain; the tail of the currently-running work. */
	#tail: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		// The worker script is this module's sibling in both source (tsx) and dist.
		// Match the current module's extension so we find the compiled `.js` in
		// dist and the `.ts` source under tsx.
		const here = dirname(fileURLToPath(import.meta.url));
		const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
		const workerFile = join(here, `async-db-worker${ext}`);
		this.#worker = new Worker(workerFile, {
			workerData: { dbPath: path },
		});
		this.#worker.on("message", (msg: { id: number; ok: boolean; value?: unknown; error?: { message: string; stack?: string } }) => {
			const p = this.#pending.get(msg.id);
			if (!p) return;
			this.#pending.delete(msg.id);
			if (msg.ok) p.resolve(msg.value);
			else {
				const e = new Error(msg.error?.message ?? "sqlite worker error");
				if (msg.error?.stack) e.stack = msg.error.stack;
				p.reject(e);
			}
		});
		this.#worker.on("error", (e) => {
			this.#rejectAll(new Error(`async-db worker crashed: ${e.message}`));
		});
	}

	/** Synchronously obtain a (cached) statement handle; the async ops await. */
	prepare(sql: string): AsyncStatement {
		return new AsyncStatement(this, sql);
	}

	async exec(sql: string): Promise<void> {
		await this.invoke("exec", sql);
	}

	async pragma(stmt: string): Promise<unknown> {
		return this.invoke("pragma", stmt);
	}

	/**
	 * Run `fn` inside a transaction. Returns the function to call (mirrors
	 * better-sqlite3's `db.transaction(fn)()` shape), but async. The transaction
	 * holds the exclusive mutex for the whole body, so no concurrent statement
	 * can enter the open transaction; on throw it rolls back.
	 */
	transaction<R>(fn: () => Promise<R>): () => Promise<R> {
		return () => this.#exclusive(() =>
			// The whole transaction (begin, body, commit/rollback) runs inside the
			// IN_TX context, so every statement bypasses the outer mutex the tx
			// already holds. An ordered invoke inside the tx must not chain onto
			// the tail again — that would wait on its own completion.
			IN_TX.run(true, async () => {
				await this.invoke("begin", undefined);
				let ok = false;
				try {
					const result = await fn();
					ok = true;
					return result;
				} finally {
					await this.invoke(ok ? "commit" : "rollback");
				}
			}),
		);
	}

	async close(): Promise<void> {
		await this.invoke("close");
		this.#worker.terminate();
	}

	invoke(op: string, sql?: string, params?: unknown[]): Promise<unknown> {
		// Calls made from inside an open transaction bypass the outer mutex (the
		// transaction holds it); everything else is serialised behind it.
		if (IN_TX.getStore()) {
			return this.#send(op, sql, params);
		}
		return this.#exclusive(() => this.#send(op, sql, params));
	}

	/** Hold the single-flight mutex through `fn`; later callers wait on it. */
	#exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.#tail.then(fn);
		// The chain waits for the actual work, surviving throws.
		this.#tail = run.catch(() => undefined);
		return run;
	}

	#send(op: string, sql?: string, params?: unknown[]): Promise<unknown> {
		const id = ++this.#nextId;
		return new Promise<unknown>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#worker.postMessage({
				id,
				op,
				sql,
				params: params && params.length > 0 ? params : undefined,
			});
		});
	}

	#rejectAll(e: Error) {
		for (const [, p] of this.#pending) p.reject(e);
		this.#pending.clear();
	}
}

/** Open an async (worker-backed) connection wrapping better-sqlite3. */
export function openAsyncDatabase(path: string): AsyncDatabase {
	return new AsyncDatabase(path);
}