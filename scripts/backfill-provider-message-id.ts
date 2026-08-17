/**
 * One-time backfill for `messages.provider_message_id`.
 *
 * Rows indexed before that column existed carry NULL. Sync inserts with
 * `INSERT OR IGNORE`, so re-running it never fills them in — but re-indexing
 * from scratch would delete rows the analysis graph already points at. This
 * updates the existing rows in place instead.
 *
 *   - Pi writes one row per assistant response, so the row id *is* the response
 *     id. One UPDATE covers every pi row.
 *   - Claude Code splits one response across a row per content block, each
 *     repeating that response's usage. Only the transcript holds the key that
 *     ties them together, so this re-reads the Claude JSONL files.
 *
 * Idempotent: it only touches rows where the column is still NULL.
 *
 * Usage: npx tsx scripts/backfill-provider-message-id.ts [--dry-run]
 */
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { migrate } from "../src/db/schema.js";
import { getClaudeSessionsDir, getDbPath, loadConfig } from "../src/config.js";

const dryRun = process.argv.includes("--dry-run");
const dbPath = getDbPath(loadConfig());
const claudeDir = getClaudeSessionsDir();

const db = new Database(dbPath);
migrate(db);

const pending = (): number =>
	(db.prepare("SELECT COUNT(*) c FROM messages WHERE provider_message_id IS NULL AND role = 'assistant'").get() as { c: number }).c;

console.log(`Database: ${dbPath}`);
console.log(`Assistant rows missing provider_message_id: ${pending()}`);

// ── Pi: the row id is the response id ──
const piResult = dryRun
	? { changes: (db.prepare("SELECT COUNT(*) c FROM messages WHERE source = 'pi' AND role = 'assistant' AND provider_message_id IS NULL").get() as { c: number }).c }
	: db.prepare("UPDATE messages SET provider_message_id = id WHERE source = 'pi' AND role = 'assistant' AND provider_message_id IS NULL").run();
console.log(`  pi rows:     ${piResult.changes}`);

// ── Claude: recover message.id from the transcripts ──
function* jsonlFiles(dir: string): Generator<string> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) yield* jsonlFiles(p);
		else if (e.isFile() && e.name.endsWith(".jsonl")) yield p;
	}
}

const update = db.prepare(
	"UPDATE messages SET provider_message_id = ? WHERE id = ? AND provider_message_id IS NULL",
);
let claudeUpdated = 0;
let filesRead = 0;

const applyFile = db.transaction((pairs: Array<[string, string]>) => {
	for (const [messageId, rowId] of pairs) claudeUpdated += update.run(messageId, rowId).changes;
});

for (const file of jsonlFiles(claudeDir)) {
	filesRead++;
	const pairs: Array<[string, string]> = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		if (obj.type !== "assistant" || typeof obj.uuid !== "string") continue;
		const msg = obj.message as Record<string, unknown> | undefined;
		if (!msg || typeof msg.id !== "string") continue;
		pairs.push([msg.id, obj.uuid]);
	}
	if (pairs.length > 0 && !dryRun) applyFile(pairs);
	else if (dryRun) claudeUpdated += pairs.length;
}

console.log(`  claude rows: ${claudeUpdated} (from ${filesRead} transcripts)`);
console.log(dryRun ? "\nDry run — nothing written." : `\nRemaining without an id: ${pending()}`);

db.close();
