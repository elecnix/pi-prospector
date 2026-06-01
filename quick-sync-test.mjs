#!/usr/bin/env node
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const DB_PATH = path.join(os.homedir(), ".pi", "agent", "prospector.db");
const SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");

const db = new Database(DB_PATH);

// Count total sessions and messages
let totalFiles = 0;
let totalMessages = 0;

const dirs = fs.readdirSync(SESSIONS_DIR).filter(d => d.startsWith("--home-nicolas--"));
for (const dir of dirs.slice(0, 3)) {
	const sessionPath = path.join(SESSIONS_DIR, dir);
	const files = fs.readdirSync(sessionPath).filter(f => f.endsWith(".jsonl"));
	for (const file of files.slice(0, 5)) {
		const filePath = path.join(sessionPath, file);
		const content = fs.readFileSync(filePath, "utf-8");
		const lines = content.split("\n").filter(l => l.trim());
		const sessionLines = lines.filter(l => l.startsWith("{")).length;
		totalMessages += sessionLines;
		totalFiles++;
	}
}

console.log(`Found ${totalFiles} files with approx ${totalMessages} messages`);
db.close();
