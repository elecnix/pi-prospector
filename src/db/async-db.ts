import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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
 * runs.
 *
 * The worker thread does real parallel execution: the connection lives in the
 * worker's address space and its C calls run in that thread, so the event loop
 * is never stopped. This is verified by `scripts/async-probe.mjs`, which shows
 * 11+ event-loop ticks firing during a worker-backed write vs. 0 for the same
 * work on the main thread.
 *
 * API note: `.get/.all/.run` return Promises (the response crosses a
 * structured-clone boundary). `.prepare()` stays synchronous so statement
 * handles are cheap; only the execution methods await.
 */

/** A prepared statement bound to the worker's connection, with async execution. */
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

interface Pending {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
}

export class AsyncDatabase {
	#worker: Worker;
	#nextId = 0;
	#pending = new Map<number, Pending>();

	constructor(path: string) {
		// The worker script is this module's sibling in both source (tsx) and dist.
		// Match the current module's extension so we find the compiled `.js_sib` in
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
	 * Run `fn` inside a transaction, committing on success and rolling back on
	 * throw. Returns the function to call (mirrors better-sqlite3's
	 * `db.transaction(fn)()` shape), but as an async function.
	 */
	transaction<R>(fn: () => Promise<R>): () => Promise<R> {
		return async () => {
			await this.invoke("begin", undefined);
			let ok = false;
			try {
				const result = await fn();
				ok = true;
				return result;
			} finally {
				await this.invoke(ok ? "commit" : "rollback");
			}
		};
	}

	async close(): Promise<void> {
		await this.invoke("close");
		this.#worker.terminate();
	}

	invoke(op: string, sql?: string, params?: unknown[]): Promise<unknown> {
		const id = ++this.#nextId;
		const p = new Promise<unknown>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
		});
		this.#worker.postMessage({ id, op, sql, params: params && params.length > 0 ? params : undefined });
		return p;
	}

	#rejectAll(e: Error) {
		for (const [, p] of this.#pending) p.reject(e);
		this.#pending.clear();
	}
}

function worker(path: string): AsyncDatabase {
	return new AsyncDatabase(path);
}

export { worker as openAsyncDatabase };