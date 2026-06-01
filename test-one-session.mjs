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

async function main() {
	const db = new Database(DB_PATH);
	migrate(db);
	
	// Use one of the recent session files
	const sesPath = "/home/nicolas/.pi/agent/sessions/--home-nicolas-Source-pi-prospector-laguna-m.1-analyzer-impl--/2026-05-31T04-14-51-995Z_019e7c3d-e65b-727b-ba9d-80b506a9591b.jsonl";
	const content = fs.readFileSync(sesPath, "utf-8");
	const lines = content.split("\n");
	
	console.log(`Loading ${lines.length} lines from ${sesPath}`);
	
	// Parse session header
	let sessionId = "";
	let parentSession = null;
	let cwd = "";
	let startedAt = "";
	let project = "pi-prospector-laguna-m.1-analyzer-impl";
	
	for (const line of lines) {
		if (!line.trim()) continue;
		const parsed = parseLine(line);
		if (parsed && parsed.kind === "session") {
			sessionId = parsed.header.id;
			parentSession = parsed.header.parentSession ?? null;
			cwd = parsed.header.cwd ?? "";
			startedAt = parsed.header.timestamp ?? "";
			break;
		}
	}
	
	console.log(`Session ID: ${sessionId}`);
	
	if (!sessionId) {
		console.log("No session header found!");
		db.close();
		return;
	}
	
	// Insert session
	db.prepare("INSERT OR REPLACE INTO sessions (id, file_path, project, cwd, started_at, last_line, message_count) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
		sessionId, sesPath, project, cwd, startedAt, lines.length, 0
	);
	
	// Insert analyzer def
	db.prepare("INSERT OR IGNORE INTO analyzer_defs (id, label, description, anchor_span, dependencies, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
		"turn-pair-core", "Per-Turn Deterministic Metrics", "Extracts deterministic metrics from user-assistant turn pairs", "pair", "[]", new Date().toISOString()
	);
	
	// Insert analyzer version
	db.prepare("INSERT OR IGNORE INTO analyzer_versions (analyzer_id, version_id, implementation_kind, code_ref, created_at) VALUES (?, ?, ?, ?, ?)").run(
		"turn-pair-core", "v1.0.0", "deterministic", "src/commands/turn-pair-core-analyzer.ts", new Date().toISOString()
	);
	
	// Insert analyzer config
	db.prepare("INSERT OR IGNORE INTO analyzer_configs (id, analyzer_id, config_hash, config_json, label, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
		"turn-pair-core-config-v1", "turn-pair-core", "default-config-hash", '{"friction_threshold":0.5}', "default", new Date().toISOString()
	);
	
	// Parse and insert messages
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
	console.log(`Inserted ${msgCount} messages`);
	
	// Run analyzer
	const framework = new AnalyzerFramework(db);
	const result = await framework.run(turnPairCoreAnalyzer, sessionId);
	console.log(`\n=== Analyzer created ${result.nodesProduced} nodes, skipped ${result.nodesSkipped} ===\n`);
	
	// Show results
	const nodes = db.prepare("SELECT * FROM analysis_nodes").all();
	console.log(`Created ${nodes.length} analysis nodes`);
	
	for (const node of nodes.slice(0, 5)) {
		const content = JSON.parse(node.content_json);
		console.log(`Friction: ${content.friction_score}, Correction: ${content.correction_detected}, Tools: ${content.tool_call_count}`);
	}
	
	db.close();
}

main().catch(console.error);
