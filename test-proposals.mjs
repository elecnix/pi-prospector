#!/usr/bin/env node
import Database from "better-sqlite3";
import { materializeSession } from "./dist/proposal-materializer.js";
import * as path from "node:path";
import * as os from "node:os";

async function main() {
	const DB_PATH = path.join(os.homedir(), ".pi", "agent", "prospector.db");
	const db = new Database(DB_PATH);
	
	// Get a session with corrections
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
	
	console.log(`Materializing proposals for: ${session.session_id}`);
	const count = await materializeSession(db, session.session_id);
	console.log(`Created ${count} proposals`);
	
	// Show proposals
	const props = db.prepare("SELECT * FROM proposals WHERE session_id = ?").all(session.session_id);
	console.log("\nProposals:");
	for (const p of props) {
		console.log(`  [${p.severity}] ${p.summary}`);
	}
	
	db.close();
}

main().catch(console.error);
