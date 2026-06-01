#!/usr/bin/env node
import Database from "better-sqlite3";
import { AnalyzerFramework } from "./dist/analyze.js";
import { turnPairLLMAnalyzer } from "./dist/commands/turn-pair-llm-analyzer.js";
import * as path from "node:path";
import * as os from "node:os";

async function main() {
	const DB_PATH = path.join(os.homedir(), ".pi", "agent", "prospector.db");
	const db = new Database(DB_PATH);
	
	const framework = new AnalyzerFramework(db);
	
	// Insert LLM analyzer def
	db.prepare("INSERT OR IGNORE INTO analyzer_defs (id, label, description, anchor_span, dependencies, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
		"turn-pair-llm", "Per-Turn LLM Sentiment & Friction", "LLM enrichment for high-signal turn pairs", "pair", '["turn-pair-core"]', new Date().toISOString()
	);
	db.prepare("INSERT OR IGNORE INTO analyzer_versions (analyzer_id, version_id, implementation_kind, code_ref, created_at) VALUES (?, ?, ?, ?, ?)").run(
		"turn-pair-llm", "v1.0.0", "in_process_llm", "src/commands/turn-pair-llm-analyzer.ts", new Date().toISOString()
	);
	db.prepare("INSERT OR IGNORE INTO analyzer_configs (id, analyzer_id, config_hash, config_json, label, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
		"turn-pair-llm-config-v1", "turn-pair-llm", "default-config-hash", '{"friction_threshold":0.3}', "default", new Date().toISOString()
	);
	
	// Get top 3 sessions with corrections
	const sessions = db.prepare(`
		SELECT DISTINCT session_id FROM analysis_nodes 
		WHERE analyzer_id = 'turn-pair-core' AND json_extract(content_json, '$.correction_detected') = 1
		LIMIT 3
	`).all();
	
	console.log(`Found ${sessions.length} sessions with corrections`);
	
	let totalNodes = 0;
	for (const { session_id } of sessions) {
		const result = await framework.run(turnPairLLMAnalyzer, session_id);
		totalNodes += result.nodesProduced;
		console.log(`Session ${session_id}: ${result.nodesProduced} nodes created`);
	}
	
	// Sample output
	const sample = db.prepare("SELECT * FROM analysis_nodes WHERE analyzer_id = 'turn-pair-llm' LIMIT 2").all();
	console.log("\n=== Sample Enriched Nodes ===");
	for (const node of sample) {
		const c = JSON.parse(node.content_json);
		console.log(JSON.stringify({
			sentiment: c.sentiment,
			frustration_level: c.frustration_level,
			quality_score: c.quality_score,
			friction_cause: c.friction_cause,
			llm_enriched: c.llm_enriched,
		}, null, 2));
	}
	
	console.log(`\nTotal LLM nodes: ${totalNodes}`);
	db.close();
}

main().catch(console.error);
