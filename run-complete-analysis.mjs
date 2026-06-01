#!/usr/bin/env node
/**
 * Complete analysis workflow
 * - Run turn-pair-core on all sessions
 * - Run turn-pair-llm on high-friction sessions
 * - Generate proposals
 */

import Database from "better-sqlite3";
import { AnalyzerFramework } from "./dist/analyze.js";
import { turnPairCoreAnalyzer, turnPairCoreAnalyzer as coreAnalyzer } from "./dist/commands/turn-pair-core-analyzer.js";
import { materializeSession } from "./dist/proposal-materializer.js";
import * as path from "node:path";
import * as os from "node:os";

async function main() {
	const DB_PATH = path.join(os.homedir(), ".pi", "agent", "prospector.db");
	const db = new Database(DB_PATH);
	
	console.log("=== Running Complete Analysis Workflow ===\n");
	
	const framework = new AnalyzerFramework(db);
	
	// Get all sessions without analysis
	const sessions = db.prepare(`
		SELECT s.id, s.project 
		FROM sessions s 
		LEFT JOIN analysis_nodes n ON s.id = n.session_id AND n.analyzer_id = 'turn-pair-core'
		WHERE n.id IS NULL
		LIMIT 10
	`).all();
	
	console.log(`Found ${sessions.length} sessions to analyze`);
	
	for (const { id, project } of sessions) {
		const result = await framework.run(coreAnalyzer, id);
		console.log(`Session ${id.slice(0, 8)}.. (${project}): ${result.nodesProduced} nodes`);
	}
	
	// Generate proposals for top session
	const topSession = db.prepare(`
		SELECT DISTINCT session_id 
		FROM analysis_nodes 
		WHERE analyzer_id = 'turn-pair-core' AND json_extract(content_json, '$.friction_score') > 0.3
		LIMIT 1
	`).get();
	
	if (topSession) {
		const propCount = await materializeSession(db, topSession.session_id);
		console.log(`\nGenerated ${propCount} proposals for session ${topSession.session_id.slice(0, 8)}..`);
	}
	
	// Final stats
	const stats = db.prepare(`
		SELECT 
			COUNT(DISTINCT session_id) as sessions,
			COUNT(*) as nodes,
			COUNT(CASE WHEN json_extract(content_json, '$.correction_detected') = 1 THEN 1 END) as corrections
		FROM analysis_nodes 
		WHERE analyzer_id = 'turn-pair-core'
	`).get();
	
	console.log(`\n=== Final Stats ===`);
	console.log(`Sessions: ${stats.sessions}`);
	console.log(`Nodes: ${stats.nodes}`);
	console.log(`Corrections: ${stats.corrections}`);
	
	db.close();
}

main().catch(console.error);
