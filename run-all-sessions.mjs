#!/usr/bin/env node
import Database from "better-sqlite3";
import { migrate } from "./dist/db/schema.js";
import { AnalyzerFramework } from "./dist/analyze.js";
import { turnPairCoreAnalyzer } from "./dist/commands/turn-pair-core-analyzer.js";
import * as path from "node:path";
import * as os from "node:os";

const DB_PATH = path.join(os.homedir(), ".pi", "agent", "prospector.db");

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
	
	// Get all sessions without analysis
	const sessions = db.prepare("SELECT id FROM sessions").all();
	console.log(`Found ${sessions.length} sessions to analyze`);
	
	let analyzed = 0;
	let skipped = 0;
	let corrections = 0;
	
	for (const { id: sessionId } of sessions) {
		try {
			const result = await framework.run(turnPairCoreAnalyzer, sessionId);
			analyzed += 1;
			skipped += result.nodesSkipped;
			
			// Count corrections
			const nodes = db.prepare("SELECT content_json FROM analysis_nodes WHERE session_id = ?").all(sessionId);
			for (const node of nodes) {
				const c = JSON.parse(node.content_json);
				if (c.correction_detected) corrections++;
			}
			
			if (analyzed % 10 === 0) {
				console.log(`Progress: ${analyzed} sessions analyzed...`);
			}
		} catch (e) {
			console.error(`Error: ${e}`);
			break;
		}
	}
	
	console.log(`\n=== Analyzed: ${analyzed} sessions, skipped ${skipped} (idempotency), found ${corrections} corrections ===`);
	
	// Top findings
	const topNodes = db.prepare(`
		SELECT n.content_json, s.project 
		FROM analysis_nodes n 
		JOIN sessions s ON n.session_id = s.id 
		WHERE json_extract(n.content_json, '$.friction_score') > 0.3 
		ORDER BY json_extract(n.content_json, '$.friction_score') DESC 
		LIMIT 5
	`).all();
	
	console.log("\n=== High Friction Samples ===");
	for (const row of topNodes) {
		const c = JSON.parse(row.content_json);
		console.log(`${row.project}: friction=${c.friction_score}, correction=${c.correction_detected}`);
	}
	
	db.close();
}

main().catch(console.error);
