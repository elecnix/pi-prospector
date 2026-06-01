#!/usr/bin/env node
import Database from "better-sqlite3";
import { migrate } from "./dist/db/schema.js";
import { parseLine } from "./dist/sync/parser.js";
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
	
	// Insert analyzer def
	db.prepare("INSERT OR IGNORE INTO analyzer_defs (id, label, description, anchor_span, dependencies, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
		"turn-pair-core", "Per-Turn Deterministic Metrics", "Extracts deterministic metrics from user-assistant turn pairs", "pair", "[]", new Date().toISOString()
	);
	db.prepare("INSERT OR IGNORE INTO analyzer_versions (analyzer_id, version_id, implementation_kind, code_ref, created_at) VALUES (?, ?, ?, ?, ?)").run(
		"turn-pair-core", "v1.0.0", "deterministic", "src/commands/turn-pair-core-analyzer.ts", new Date().toISOString()
	);
	db.prepare("INSERT OR IGNORE INTO analyzer_configs (id, analyzer_id, config_hash, config_json, label, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
		"turn-pair-core-config-v1", "turn-pair-core", "default-config-hash", '{"friction_threshold":0.5}', "default", new Date().toISOString()
	);

	const framework = new AnalyzerFramework(db);
	let totalSessions = 0;
	let totalNodes = 0;
	let totalCorrections = 0;
	
	// Process recent sessions
	const dirs = fs.readdirSync(SESSIONS_DIR).filter(d => d.startsWith("--home-nicolas-Source--"));
	for (const dir of dirs.slice(0, 3)) {
		const sessionPath = path.join(SESSIONS_DIR, dir);
		const files = fs.readdirSync(sessionPath).filter(f => f.endsWith(".jsonl")).sort().reverse();
		
		for (const file of files.slice(0, 2)) {
			const filePath = path.join(sessionPath, file);
			const content = fs.readFileSync(filePath, "utf-8");
			const lines = content.split("\n");
			
			let sessionId = "";
			let project = dir.replace("--home-nicolas-Source-", "").replace(/--/g, "/");
			
			for (const line of lines) {
				if (!line.trim()) continue;
				const parsed = parseLine(line);
				if (parsed && parsed.kind === "session") {
					sessionId = parsed.header.id;
					break;
				}
			}
			
			if (!sessionId) continue;
			
			// Check if already synced
			const existing = db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId);
			if (existing) {
				console.log(`Skipping ${sessionId} (already synced)`);
				continue;
			}
			
			console.log(`Processing ${sessionId}...`);
			
			// Insert session FIRST (foreign key)
			db.prepare("INSERT OR REPLACE INTO sessions (id, file_path, project, cwd, started_at, last_line, message_count) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
				sessionId, filePath, project, "", "", lines.length, 0
			);
			
			// Then insert messages
			let msgCount = 0;
			for (const line of lines) {
				if (!line.trim()) continue;
				const parsed = parseLine(line);
				if (!parsed || parsed.kind === "session") continue;
				
				const entry = parsed.entry;
				db.prepare(`INSERT OR REPLACE INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
					entry.id, sessionId, entry.parentId, entry.timestamp, entry.role, entry.text, 
					entry.thinking,
					entry.tool_calls ? JSON.stringify(entry.tool_calls) : null,
					entry.tool_results ? JSON.stringify(entry.tool_results) : null,
					null
				);
				msgCount++;
			}
			
			db.prepare("UPDATE sessions SET message_count = ? WHERE id = ?").run(msgCount, sessionId);
			
			// Run analyzer
			try {
				const result = await framework.run(turnPairCoreAnalyzer, sessionId);
				totalNodes += result.nodesProduced;
				totalSessions++;
				
				// Count corrections - use session_id not source_session_id
				const nodes = db.prepare("SELECT content_json FROM analysis_nodes WHERE session_id = ?").all(sessionId);
				for (const node of nodes) {
					const c = JSON.parse(node.content_json);
					if (c.correction_detected) totalCorrections++;
				}
			} catch (e) {
				console.error(`Error analyzing ${sessionId}: ${e}`);
			}
		}
	}
	
	console.log(`\n=== Total: ${totalSessions} sessions, ${totalNodes} nodes, ${totalCorrections} corrections ===`);
	db.close();
}

main().catch(console.error);
