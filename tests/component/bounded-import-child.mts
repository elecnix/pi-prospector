// Child process of bounded-import.test.ts: imports one sessions root with a low heap and reports its peak.
import * as fs from "node:fs";
const [root, dbPath, maxLines, maxBytes] = process.argv.slice(2) as [string, string, string, string];
const { openAsyncDatabase } = await import("../../src/db/async-db.js");
const { migrate } = await import("../../src/db/schema.js");
const { runSync } = await import("../../src/sync/index.js");
const { ClaudeFileSource } = await import("../../src/sync/sources/claude/index.js");
const { setBatchLimitsForTests } = await import("../../src/sync/line-batches.js");
setBatchLimitsForTests({ maxLines: Number(maxLines), maxBytes: Number(maxBytes) });
let peak = 0;
const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 20);
const db = openAsyncDatabase(dbPath);
await migrate(db);
const result = await runSync(db, [new ClaudeFileSource(root)], {});
clearInterval(timer);
peak = Math.max(peak, process.memoryUsage().heapUsed);
const n = (await db.prepare("SELECT COUNT(*) AS n FROM messages").get()) as { n: number };
await db.close();
fs.writeSync(1, JSON.stringify({ peakHeapMB: Math.round(peak / 1e6), errors: result.errors, messages: n.n }) + "\n");
