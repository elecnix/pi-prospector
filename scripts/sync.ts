/**
 * Standalone sync runner for pi-prospector.
 * Usage: npx tsx scripts/sync.ts
 */
import Database from "better-sqlite3";
import { migrate } from "../src/db/schema.js";
import { runSync } from "../src/sync/index.js";
import { getClaudeSessionsDir, getDbPath, getSessionsDir, loadConfig } from "../src/config.js";

const config = loadConfig();
const dbPath = getDbPath(config);
const sessionsDir = getSessionsDir();
const claudeSessionsDir = getClaudeSessionsDir();

console.log(`Database: ${dbPath}`);
console.log(`Sessions: ${sessionsDir}`);
console.log(`Claude:   ${claudeSessionsDir}`);
console.log();

const db = new Database(dbPath);
migrate(db);

try {
	const result = runSync(db, sessionsDir, claudeSessionsDir);
	const lines = [
		"⛏️  Prospect sync complete",
		`  Sessions processed: ${result.sessionsProcessed}`,
		`  Sessions skipped:   ${result.sessionsSkipped}`,
		`  Messages inserted:  ${result.messagesInserted}`,
		`  Forks resolved:     ${result.forksResolved}`,
	];
	if (result.errors.length > 0) {
		lines.push(`  Errors: ${result.errors.length}`);
		for (const e of result.errors.slice(0, 10)) lines.push(`    - ${e}`);
		if (result.errors.length > 10) lines.push(`    ... and ${result.errors.length - 10} more`);
	}
	console.log(lines.join("\n"));
} finally {
	db.close();
}