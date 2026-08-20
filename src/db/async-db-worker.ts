import Database from "better-sqlite3";
import { parentPort, workerData } from "node:worker_threads";

/**
 * Worker-thread owner of the better-sqlite3 connection.
 *
 * This is the "async driver" seam: the main thread never touches sqlite. Every
 * statement runs on this worker, where a single better-sqlite3 connection gives
 * implicit transactional serialization. A per-connection promise-queue mutex
 * keeps even interleaved callers from overlapping mid-batch, and the prepared
 * statement cache lives here keyed by SQL (the main thread holds only the SQL
 * string + an opaque numeric handle).
 *
 * Results are deep-walked into structured-clone-safe values before crossing the
 * bridge, because `structuredClone` rejects values better-sqlite3 can return
 * (notably `Buffer` for BLOB columns).
 */

interface WorkerMsg {
	id: number;
	op: string;
	sql?: string;
	params?: unknown;
}

/** Serialize one value for the structured-clone boundary. */
function mono(v: unknown): unknown {
	if (v === null || v === undefined) return v;
	const t = typeof v;
	if (t === "number" || t === "string" || t === "boolean" || t === "bigint") return v;
	if (Array.isArray(v)) return v.map(mono);
	if (v instanceof Buffer) return Array.from(v);
	if (v instanceof Uint8Array) return Array.from(v);
	if (v instanceof Date) return v.toISOString();
	if (typeof v === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = mono(val);
		return out;
	}
	throw new TypeError(`unsupported column value: ${String(v)} (${t})`);
}

/** A promise-chain queue so only one statement/transaction runs at a time. */
function makeMutex() {
	let tail: Promise<unknown> = Promise.resolve();
	return {
		enqueue<T>(fn: () => T): Promise<T> {
			const p = tail.then(fn);
			// Chain so the next step waits for THIS one (the actual fn), even on throw.
			tail = p.catch(() => {});
			return p;
		},
	};
}

const dbPath = (workerData as { dbPath: string }).dbPath;
const db = new Database(dbPath);
// Keys are the SQL string; values are the prepared Statement.
const stmtCache = new Map<string, Database.Statement>();
const mutex = makeMutex();

function statement(sql: string): Database.Statement {
	let s = stmtCache.get(sql);
	if (!s) {
		s = db.prepare(sql);
		stmtCache.set(sql, s);
	}
	return s;
}

function runStmt(sql: string, params: unknown) {
	const s = statement(sql);
	if (params !== undefined && Array.isArray(params)) return s.run(...params);
	if (params !== undefined && typeof params === "object") return s.run(params as unknown as Record<string, unknown>);
	return s.run();
}

function getStmt(sql: string, params: unknown) {
	const s = statement(sql);
	if (params !== undefined && Array.isArray(params)) return s.get(...params);
	if (params !== undefined && typeof params === "object") return s.get(params as unknown as Record<string, unknown>);
	return s.get();
}

function allStmt(sql: string, params: unknown) {
	const s = statement(sql);
	if (params !== undefined && Array.isArray(params)) return s.all(...params);
	if (params !== undefined && typeof params === "object") return s.all(params as unknown as Record<string, unknown>);
	return s.all();
}

function run(msg: WorkerMsg): unknown {
	switch (msg.op) {
		case "run":
			return mono(runStmt(msg.sql!, msg.params));
		case "get":
			return mono(getStmt(msg.sql!, msg.params));
		case "all":
			return mono(allStmt(msg.sql!, msg.params));
		case "exec":
			db.exec(msg.sql!);
			return undefined;
		case "pragma":
			return mono(db.pragma(msg.sql!));
		case "begin":
			db.exec("BEGIN");
			return undefined;
		case "commit":
			db.exec("COMMIT");
			return undefined;
		case "rollback":
			db.exec("ROLLBACK");
			return undefined;
		case "close":
			db.close();
			return undefined;
		default:
			throw new Error(`unknown worker op: ${String(msg.op)}`);
	}
}

parentPort!.on("message", (msg: WorkerMsg) => {
	mutex
		.enqueue(() => run(msg))
		.then((value) => {
			parentPort!.postMessage({ id: msg.id, ok: true, value });
		})
		.catch((err: unknown) => {
			const e = err instanceof Error ? err : new Error(String(err));
			parentPort!.postMessage({
				id: msg.id,
				ok: false,
				error: { message: e.message, stack: e.stack, code: "ERR_SQLITE" },
			});
		});
});