/**
 * Standalone sync runner for pi-prospector.
 * Usage: npx tsx scripts/sync.ts
 */
import { migrate } from "../src/db/schema.js";
import { openAsyncDatabase } from "../src/db/async-db.js";
import { runSync } from "../src/sync/index.js";
import { PiFileSource } from "../src/sync/sources/pi-file.js";
import { ClaudeFileSource } from "../src/sync/sources/claude-file.js";
import { getClaudeSessionsDir, getDbPath, getSessionsDir, loadConfig } from "../src/config.js";

const config = loadConfig();
const dbPath = getDbPath(config);
const sessionsDir = getSessionsDir();
const claudeSessionsDir = getClaudeSessionsDir();

console.log(`Database: ${dbPath}`);
console.log(`Sessions: ${sessionsDir}`);
console.log(`Claude:   ${claudeSessionsDir}`);
console.log();

const db = openAsyncDatabase(dbPath);
await migrate(db);

try {
	const result = await runSync(db, [new PiFileSource(sessionsDir), new ClaudeFileSource(claudeSessionsDir)]);
	const lines = [
		"⛏️  Prospect sync complete",
		`  Sessions processed: ${result.sessionsProcessed}`,
		`  Sessions skipped:   ${result.sessionsSkipped}`,
		`  Messages inserted:  ${result.messagesInserted}`,
		`  Forks resolved:     ${result.forksResolved}`,
		`  Subagent runs:      ${result.subagentRunsProcessed} ingested, ${result.subagentRunsSkipped} unchanged`,
	];
	if (result.errors.length > 0) {
		lines.push(`  Errors: ${result.errors.length}`);
		for (const e of result.errors.slice(0, 10)) lines.push(`    - ${e}`);
		if (result.errors.length > 10) lines.push(`    ... and ${result.errors.length - 10} more`);
	}
	console.log(lines.join("\n"));
} finally {
	await db.close();
}
