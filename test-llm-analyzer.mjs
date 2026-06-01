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
	
	// Clear any existing LLM runs
	db.prepare("DELETE FROM analysis_nodes WHERE analyzer_id = 'turn-pair-llm'").run();
	
	// Get a session with high friction - pick one with corrections
	const session = db.prepare(`
		SELECT DISTINCT session_id FROM analysis_nodes 
		WHERE analyzer_id = 'turn-pair-core' AND json_extract(content_json, '$.correction_detected') = 1
		LIMIT 1
	`).get();
	
	if (!session) {
		console.log("No sessions with corrections found");
		db.close();
		return;
	}
	
	console.log(`Running LLM analyzer on session: ${session.session_id}`);
	const result = await framework.run(turnPairLLMAnalyzer, session.session_id);
	console.log(`Created ${result.nodesProduced} nodes, skipped ${result.nodesSkipped}`);
	
	// Show enriched nodes
	const nodes = db.prepare("SELECT * FROM analysis_nodes WHERE session_id = ? AND analyzer_id = ?").all(session.session_id, "turn-pair-llm");
	console.log(`\n=== LLM-enriched nodes ===`);
	for (const node of nodes.slice(0, 3)) {
		const c = JSON.parse(node.content_json);
		console.log(`Sentiment: ${c.sentiment}, Quality: ${c.quality_score}, Enriched: ${c.llm_enriched}`);
	}
	
	db.close();
}

main().catch(console.error);
