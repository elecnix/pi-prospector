/**
 * Integration test: directly invokes pi-prospector commands without Pi runtime.
 * Tests the actual business logic end-to-end against a real database.
 */
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Import the actual modules
import { migrate } from "../../src/db/schema.js";
import { getStats, listProposals, insertProposal, acceptProposal, rejectProposal, computeDedupHash } from "../../src/db/queries.js";
import { runSync } from "../../src/sync/index.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prospector-int-"));
const dbPath = path.join(tmpDir, "test.db");
const fixtureDir = path.resolve(import.meta.dirname, "../../tests/fixtures");

let pass = 0;
let fail = 0;

function assert(condition: boolean, label: string, detail?: string): void {
	if (condition) {
		console.log(`  ✅ ${label}`);
		pass++;
	} else {
		console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
		fail++;
	}
}

console.log("═══════════════════════════════════════════");
console.log("  pi-prospector integration tests");
console.log("═══════════════════════════════════════════\n");

// --- Setup: create DB and sync fixtures ---
console.log("Setup: syncing fixture data...");
const db = new Database(dbPath);
migrate(db);
const result = runSync(db, fixtureDir);
console.log(`  Synced: ${result.sessionsProcessed} sessions, ${result.messagesInserted} messages, ${result.errors.length} errors\n`);

// --- Test: Stats ---
console.log("Stats command:");
const stats = getStats(db);
assert(stats.totalSessions >= 1, "totalSessions >= 1", `got ${stats.totalSessions}`);
assert(stats.totalMessages >= 1, "totalMessages >= 1", `got ${stats.totalMessages}`);
assert(stats.proposalsByStatus.new === 0, "no proposals initially", `got ${stats.proposalsByStatus.new}`);
console.log("");

// --- Test: Proposals (empty) ---
console.log("Proposals command (empty DB):");
const emptyProposals = listProposals(db);
assert(emptyProposals.length === 0, "no proposals initially", `got ${emptyProposals.length}`);
console.log("");

// Get a real session ID from the synced data (FK constraint requires it)
const realSessionIds = db.prepare("SELECT id FROM sessions").all() as Array<{id: string}>;
assert(realSessionIds.length >= 1, "have at least 1 synced session", `got ${realSessionIds.length}`);
const realSessionId = realSessionIds[0]!.id;

// --- Test: Insert + list proposals ---
console.log("Proposals command (with data):");
const id1 = insertProposal(db, {
	id: crypto.randomUUID(),
	created_at: new Date().toISOString(),
	session_id: realSessionId,
	severity: "suggestion",
	target: "src/foo.ts",
	summary: "Consider extracting helper function",
	detail: "The function doStuff is too long.",
	evidence: "Line 42-80 is a single function.",
	status: "new",
	dedup_hash: computeDedupHash("src/foo.ts", "suggestion", "Consider extracting helper function"),
});
assert(id1 !== undefined && id1.length > 0, "insertProposal returns id", `got ${id1}`);

const listed = listProposals(db);
assert(listed.length === 1, "listProposals returns 1", `got ${listed.length}`);
assert(listed[0]!.status === "new", "proposal status is 'new'", `got ${listed[0]!.status}`);
assert(listed[0]!.severity === "suggestion", "severity is 'suggestion'", `got ${listed[0]!.severity}`);
console.log("");

// --- Test: Accept proposal ---
console.log("Accept command:");
const acceptOk = acceptProposal(db, id1);
assert(acceptOk === true, "acceptProposal succeeds");
const accepted = listProposals(db, "accepted");
assert(accepted.length === 1, "1 accepted proposal", `got ${accepted.length}`);
const stillNew = listProposals(db, "new");
assert(stillNew.length === 0, "0 new proposals after accept", `got ${stillNew.length}`);
console.log("");

// --- Test: Reject proposal ---
console.log("Reject command:");
const id2 = insertProposal(db, {
	id: crypto.randomUUID(),
	created_at: new Date().toISOString(),
	session_id: realSessionId,
	severity: "friction",
	target: "src/bar.ts",
	summary: "Memory leak in event listener",
	detail: "addEventListener not removed on cleanup.",
	evidence: "Line 15 adds listener, no removeEventListener found.",
	status: "new",
	dedup_hash: computeDedupHash("src/bar.ts", "friction", "Memory leak in event listener"),
});
const rejectOk = rejectProposal(db, id2);
assert(rejectOk === true, "rejectProposal succeeds");
const rejected = listProposals(db, "rejected");
assert(rejected.length === 1, "1 rejected proposal", `got ${rejected.length}`);
console.log("");

// --- Test: Stats with proposals ---
console.log("Stats after proposals:");
const stats2 = getStats(db);
assert(stats2.proposalsByStatus.accepted === 1, "1 accepted in stats", `got ${stats2.proposalsByStatus.accepted}`);
assert(stats2.proposalsByStatus.rejected === 1, "1 rejected in stats", `got ${stats2.proposalsByStatus.rejected}`);
assert(stats2.proposalsByStatus.new === 0, "0 new in stats", `got ${stats2.proposalsByStatus.new}`);
console.log("");

// --- Test: Incremental re-sync ---
console.log("Incremental re-sync:");
const result2 = runSync(db, fixtureDir);
assert(result2.sessionsSkipped >= 1, "sessions skipped on re-sync", `got ${result2.sessionsSkipped}`);
assert(result2.sessionsProcessed === 0, "no new sessions processed", `got ${result2.sessionsProcessed}`);
console.log("");

// Cleanup
db.close();
try { fs.rmSync(tmpDir, { recursive: true }); } catch {}

// Summary
console.log("═══════════════════════════════════════════");
console.log(`  Results: ${pass} passed, ${fail} failed (out of ${pass + fail})`);
console.log("═══════════════════════════════════════════\n");

process.exit(fail > 0 ? 1 : 0);