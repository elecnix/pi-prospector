// Probe: prove hosting better-sqlite3 in a worker thread leaves the main
// thread's event loop free, while better-sqlite3 on the main thread blocks it.
// Uses a temp DB only — never the user's DB.
import { Worker } from "node:worker_threads";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { rmSync } from "node:fs";

const require = createRequire(import.meta.url);
const BETTER_ABS = require.resolve("better-sqlite3/package.json", { paths: [process.cwd()] })
	.replace(/package\.json$/, "");
const database = require("better-sqlite3");

const WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require(${JSON.stringify(BETTER_ABS)});
const db = new Database(workerData);
db.pragma("journal_mode = WAL");
db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)");
const ins = db.prepare("INSERT INTO t (id, v) VALUES (?, ?)");
const sel = db.prepare("SELECT COUNT(*) c FROM t");
db.exec("BEGIN");
for (let i = 0; i < 30000; i++) ins.run(i, "x".repeat(200));
db.exec("COMMIT");
parentPort.postMessage({ n: sel.get().c });
db.close();
process.exit(0);
`;

function runWorker(tmp) {
	return new Promise((resolve, reject) => {
		const t0 = Date.now();
		const w = new Worker(WORKER_SRC, { eval: true, workerData: tmp });
		w.on("message", (m) => resolve({ ...m, wallMs: Date.now() - t0 }));
		w.on("error", reject);
		w.on("exit", (c) => { if (c !== 0) reject(new Error("worker exit " + c)); });
	});
}

function heavySync() {
	const tmp = path.join(os.tmpdir(), `prospect-sync-probe-${process.pid}.db`);
	rmSync(tmp, { force: true });
	const db = database(tmp);
	db.pragma("journal_mode = WAL");
	db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)");
	const ins = db.prepare("INSERT INTO t (id, v) VALUES (?, ?)");
	db.exec("BEGIN");
	for (let i = 0; i < 30000; i++) ins.run(i, "x".repeat(200));
	db.exec("COMMIT");
	db.close();
	rmSync(tmp, { force: true });
}

function main() {
	const tmp = path.join(os.tmpdir(), `prospect-worker-probe-${process.pid}.db`);
	rmSync(tmp, { force: true });

	let ticksSync = 0;
	const iv1 = setInterval(() => ticksSync++, 5);
	heavySync();
	clearInterval(iv1);

	let ticksWorker = 0;
	const iv2 = setInterval(() => ticksWorker++, 5);
	runWorker(tmp).then((wt) => {
		clearInterval(iv2);
		rmSync(tmp, { force: true });
		console.log(JSON.stringify({
			mainThreadTicks: ticksSync,   // expected ~0 (blocked)
			workerTicks: ticksWorker,     // expected large (event loop free)
			workerN: wt.n, workerWallMs: wt.wallMs,
		}));
		process.exit(0);
	}).catch((e) => { console.error(e); process.exit(1); });
}

main();