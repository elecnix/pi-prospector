#!/usr/bin/env node
import Database from "better-sqlite3";
import { migrate } from "./dist/db/schema.js";
import { AnalyzerFramework } from "./dist/analyze.js";
import { turnPairCoreAnalyzer } from "./dist/commands/turn-pair-core-analyzer.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const DB_PATH = path.join(os.homedir(), ".pi", "agent", "prospector.db");
const SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");

async function main() {
	const db = new Database(DB_PATH);
	migrate(db);
	
	// Initialize analyzer framework
	const framework = new AnalyzerFramework(db);

	// Find real session files
	const sessionDirs = fs.readdirSync(SESSIONS_DIR).filter(d => d.startsWith("--home-nicolas--"));
	let sessionCount = 0;
	let totalNodes = 0;

	for (const dir of sessionDirs.slice(0, 5)) {
		const sessionPath = path.join(SESSIONS_DIR, dir);
		const files = fs.readdirSync(sessionPath).filter(f => f.endsWith(".jsonl"));
		
		for (const file of files.slice(0, 2)) {
			const filePath = path.join(sessionPath, file);
			const sessionId = file.replace(".jsonl", "");
			
			// Check if session exists in DB
			const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
			if (!session) continue;
			
			// Check for existing messages
			const msgCount = db.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ?").get(sessionId);
			if (!msgCount || msgCount.c === 0) continue;
			
			console.log(`\n=== Analyzing session: ${sessionId} ===`);
			
			try {
				const result = await framework.run(turnPairCoreAnalyzer, sessionId);
				totalNodes += result.nodesProduced;
				sessionCount++;
				console.log(`Created ${result.nodesProduced} nodes, skipped ${result.nodesSkipped} (idempotency)`);
			} catch (err) {
				console.error(`Error: ${err}`);
			}
		}
	}

	console.log(`\n\nTotal: ${sessionCount} sessions analyzed, ${totalNodes} nodes created`);
	
	// Show sample nodes
	const nodes = db.prepare("SELECT * FROM analysis_nodes ORDER BY created_at DESC LIMIT 3").all();
	console.log("\n=== Sample Analysis Nodes ===");
	for (const node of nodes) {
		const content = JSON.parse(node.content_json);
		console.log(JSON.stringify({
			friction_score: content.friction_score,
			correction_detected: content.correction_detected,
			tool_call_count: content.tool_call_count,
			user_msg_length: content.user_msg_length,
		}, null, 2));
	}
	
	db.close();
}

main().catch(console.error);
