#!/usr/bin/env node
import Database from "better-sqlite3";
import { AnalyzerFramework } from "./dist/analyze.js";
import { sessionOverviewAnalyzer } from "./dist/commands/session-overview-analyzer.js";
import * as path from "node:path";
import * as os from "node:os";

async function main() {
	const DB_PATH = path.join(os.homedir(), ".pi", "agent", "prospector.db");
	const db = new Database(DB_PATH);
	
	const framework = new AnalyzerFramework(db);
	
	// Insert session overview analyzer def
	db.prepare("INSERT OR IGNORE INTO analyzer_defs (id, label, description, anchor_span, dependencies, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
		"session-overview", "Session-Level Analysis & Proposals", "Session summary with proposals", "full_session", '["turn-pair-core","turn-pair-llm"]', new Date().toISOString()
	);
	db.prepare("INSERT OR IGNORE INTO analyzer_versions (analyzer_id, version_id, implementation_kind, code_ref, created_at) VALUES (?, ?, ?, ?, ?)").run(
		"session-overview", "v1.0.0", "in_process_llm", "src/commands/session-overview-analyzer.ts", new Date().toISOString()
	);
	db.prepare("INSERT OR IGNORE INTO analyzer_configs (id, analyzer_id, config_hash, config_json, label, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
		"session-overview-config-v1", "session-overview", "default-config-hash", '{"model_tier":"mid"}', "default", new Date().toISOString()
	);
	
	// Get a session with turn-pair-core analysis
	const session = db.prepare("SELECT DISTINCT session_id FROM analysis_nodes WHERE analyzer_id = 'turn-pair-core' LIMIT 1").get();
	if (!session) {
		console.log("No sessions with turn-pair-core found");
		db.close();
		return;
	}
	
	console.log(`Running session overview on: ${session.session_id}`);
	const result = await framework.run(sessionOverviewAnalyzer, session.session_id);
	console.log(`Created ${result.nodesProduced} summary node`);
	
	const node = db.prepare("SELECT * FROM analysis_nodes WHERE session_id = ? AND analyzer_id = ?").get(session.session_id, "session-overview");
	if (node) {
		const c = JSON.parse(node.content_json);
		console.log(`\nSession summary:`);
		console.log(`  Summary: ${c.session_summary}`);
		console.log(`  Total pairs: ${c.total_pairs}`);
		console.log(`  High friction: ${c.high_friction_count}`);
		console.log(`  Proposals: ${c.proposals_generated}`);
	}
	
	db.close();
}

main().catch(console.error);
