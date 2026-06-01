#!/usr/bin/env node
import Database from "better-sqlite3";
import { migrate } from "./dist/db/schema.js";
import { AnalyzerFramework } from "./dist/analyze.js";
import { turnPairCoreAnalyzer } from "./dist/commands/turn-pair-core-analyzer.js";

const DB_PATH = process.env.TEST_DB_PATH || "/tmp/test-analyzer.db";

// Create test database
const db = new Database(DB_PATH);
migrate(db);

// Insert test session
db.prepare("INSERT OR IGNORE INTO sessions (id, file_path, project, cwd, started_at, last_line, message_count) VALUES (?, ?, ?, ?, ?, 1, 2)").run(
	"test-session-1", "/test/session.jsonl", "test", "/test", new Date().toISOString()
);

// Insert analyzer def and version
db.prepare("INSERT OR IGNORE INTO analyzer_defs (id, label, description, anchor_span, dependencies, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
	"turn-pair-core", "Per-Turn Deterministic Metrics", "Extracts deterministic metrics from user-assistant turn pairs", "pair", "[]", new Date().toISOString()
);
db.prepare("INSERT OR IGNORE INTO analyzer_versions (analyzer_id, version_id, implementation_kind, code_ref, created_at) VALUES (?, ?, ?, ?, ?)").run(
	"turn-pair-core", "v1.0.0", "deterministic", "src/commands/turn-pair-core-analyzer.ts", new Date().toISOString()
);

// Insert test config
db.prepare("INSERT OR IGNORE INTO analyzer_configs (id, analyzer_id, config_hash, config_json, label, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
	"turn-pair-core-config-v1", "turn-pair-core", "default-config-hash", '{"friction_threshold":0.5}', "default", new Date().toISOString()
);

// Insert test messages (one user-assistant pair) - 10 columns, 10 values
db.prepare("INSERT OR IGNORE INTO messages VALUES (?, ?, null, null, ?, ?, null, null, null, null)").run(
	"user-1", "test-session-1", "user", "Hi, actually let me change that - I meant to use pnpm not npm."
);

db.prepare("INSERT OR IGNORE INTO messages VALUES (?, ?, null, null, ?, ?, null, null, null, null)").run(
	"assistant-1", "test-session-1", "assistant", "Sure, I'll use pnpm instead."
);

// Test turn-pair-core analyzer
console.log("\n=== Testing turn-pair-core analyzer ===\n");

const framework = new AnalyzerFramework(db);

async function runTest() {
	await framework.run(turnPairCoreAnalyzer, "test-session-1");
	
	// Check results
	const nodes = db.prepare("SELECT * FROM analysis_nodes").all();
	console.log(`Created ${nodes.length} analysis node(s)`);
	
	for (const node of nodes) {
		console.log("\nNode content:");
		console.log(JSON.stringify(JSON.parse(node.content_json), null, 2));
	}
	
	// Check idempotency - running again should skip
	await framework.run(turnPairCoreAnalyzer, "test-session-1");
	const nodes2 = db.prepare("SELECT * FROM analysis_nodes").all();
	console.log(`\nAfter second run: ${nodes2.length} analysis node(s) (should still be 1 due to idempotency)`);
	
	db.close();
	console.log("\nTest complete!");
}

runTest().catch(console.error);
