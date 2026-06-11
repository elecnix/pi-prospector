/**
 * Integration test: exercises the real analyzer pipeline end-to-end without a
 * Pi runtime. Sync fixtures → run the framework with a MOCK LLM (never a real
 * or local model) → assert the analysis graph, proposals, and lifecycle.
 */
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { migrate } from "../../src/db/schema.js";
import { getAllSessions, getStats, listProposals, acceptProposal, rejectProposal } from "../../src/db/queries.js";
import { runSync } from "../../src/sync/index.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { registerDefaults } from "../../src/analyze/defaults.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { getNodeVersions, getRevisedNode } from "../../src/db/analysis-queries.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import type { LLMRequest } from "../../src/analyze/types.js";

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

function respond(req: LLMRequest): string {
	const sys = req.system ?? "";
	if (sys.includes("classify a single turn")) {
		return JSON.stringify({ sentiment: "neutral", friction_type: "none", is_genuine_correction: false, severity: "low", rationale: "ok" });
	}
	if (sys.includes("summarise one segment")) {
		return JSON.stringify({ segment_summary: "segment", notable_points: [] });
	}
	return JSON.stringify({
		session_summary: "summary",
		key_friction_points: [],
		improvement_proposals: [
			{ target_type: "config", target_path: "prospector.json", title: "Tune model tiers", summary: "pick cheaper models", detail: "d", evidence: "e", confidence: 0.5, severity: "suggestion" },
		],
	});
}

console.log("═══════════════════════════════════════════");
console.log("  pi-prospector integration tests (v2)");
console.log("═══════════════════════════════════════════\n");

console.log("Setup: syncing fixtures…");
const db = new Database(dbPath);
migrate(db);
const sync = runSync(db, fixtureDir);
console.log(`  Synced: ${sync.sessionsProcessed} sessions, ${sync.messagesInserted} messages`);

console.log("\nStats (pre-analysis):");
const s0 = getStats(db);
assert(s0.totalSessions >= 1, "indexed >= 1 session", `got ${s0.totalSessions}`);
assert(s0.proposalsByStatus.open === 0, "no proposals initially");
assert(s0.analysis.nodes === 0, "no analysis nodes initially");

console.log("\nRun analyzer framework (fill, mock LLM):");
const mock = createMockLLM({ responder: respond, tokensPerCall: 10, costPerCall: 0.0001 });
const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
registerDefaults(fw);

const sessions = getAllSessions(db);
let totalNodes = 0;
let totalProposals = 0;
for (const session of sessions) {
	const summary = await fw.run(session.id, {});
	totalNodes += summary.nodesProduced;
	totalProposals += summary.proposalsCreated;
	assert(summary.errors.length === 0, `session ${session.id.slice(0, 8)} ran without errors`, summary.errors.join("; "));
}
assert(totalNodes > 0, "produced analysis nodes", `got ${totalNodes}`);
assert(totalProposals > 0, "materialised proposals", `got ${totalProposals}`);

console.log("\nGraph stats:");
const s1 = getStats(db);
assert(s1.analysis.nodes > 0, "analysis nodes recorded");
assert((s1.analysis.nodesByKind["summary"] ?? 0) >= 1, "summary nodes present");
assert((s1.analysis.nodesByKind["metric"] ?? 0) >= 1, "metric nodes present");

console.log("\nIdempotent re-run (fill):");
let reRunNodes = 0;
for (const session of sessions) {
	const summary = await fw.run(session.id, {});
	reRunNodes += summary.nodesProduced;
}
assert(reRunNodes === 0, "fill re-run produces nothing new", `got ${reRunNodes}`);

console.log("\nRevise re-run with a new analyzer version (lineage):");
const firstSession = sessions[0]!;
const v2 = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
v2.register({ ...turnPairCoreAnalyzer, version: { ...turnPairCoreAnalyzer.version, major: 2 } });
const deep = await v2.run(firstSession.id, { revise: ["major"], analyzerIds: ["turn-pair-core"] });
assert(deep.nodesRevised > 0, "revise run revised stale nodes", `got ${deep.nodesRevised}`);

const coreRows = db
	.prepare("SELECT source_set_hash FROM analysis_nodes WHERE analyzer_id = 'turn-pair-core' AND session_id = ? LIMIT 1")
	.get(firstSession.id) as { source_set_hash: string } | undefined;
if (coreRows) {
	const versions = getNodeVersions(db, "turn-pair-core", coreRows.source_set_hash);
	assert(versions.length === 2, "two versions coexist for a logical unit", `got ${versions.length}`);
	const newest = versions[versions.length - 1]!;
	assert(getRevisedNode(db, newest.id) !== undefined, "newest version revises an older one");
}

console.log("\nProposal lifecycle:");
const proposals = listProposals(db, "open");
assert(proposals.length >= 1, "has open proposals");
const pid = proposals[0]!.id;
assert(acceptProposal(db, pid) === true, "accept an open proposal");
assert(acceptProposal(db, pid) === false, "cannot re-accept");
const other = listProposals(db, "open")[0];
if (other) assert(rejectProposal(db, other.id) === true, "reject another proposal");

const s2 = getStats(db);
assert(s2.proposalsByStatus.applied >= 1, "stats report applied proposals");

db.close();
try {
	fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {
	/* ignore */
}

console.log("\n═══════════════════════════════════════════");
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log("═══════════════════════════════════════════");
if (fail > 0) process.exit(1);
