/**
 * Component tests for the similarity-cluster analyzer (issue #145), exercised
 * end-to-end through the real AnalyzerFramework over synthetic sessions. No
 * real session data, no network: the mock LLM only satisfies construction,
 * because the analyzer never touches the LLM seam.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AsyncDatabase } from "../../src/db/async-db.js";
import {
	tempDb,
	insertSession,
	insertMessages,
	mockFramework,
	mockFrameworkWithOverrides,
	readAnalyzerNodes,
	assertPlainRerunIsNoOpFill,
	reviseBesidePredecessor,
	sessionProposals,
	nodeEdges,
	type TestMessage,
} from "./helpers.js";
import { similarityClusterAnalyzer } from "../../src/analyze/analyzers/similarity-cluster/index.js";

const ANALYZER_ID = "similarity-cluster";
const CWD = "/home/user/proj";

// ─────────────────────────── fixtures ───────────────────────────

/** The correction the user keeps re-typing across sessions. */
const CORRECTION_PROMPT =
	"Please don't use sed -i on macOS, use sed -i '' instead — that broke three files last week and cost an hour to undo.";

function promptOnlyMessages(): TestMessage[] {
	return [
		{ role: "user", text: CORRECTION_PROMPT },
		{ role: "assistant", text: "Understood." },
	];
}

let callSeq = 0;
function bashCallMsg(command: string): TestMessage[] {
	const id = `c${callSeq++}`;
	return [
		{ role: "assistant", stopReason: "toolUse", toolCalls: [{ id, name: "bash", arguments: { command } }] },
		{
			role: "toolResult",
			text: "ok",
			toolResults: [{ toolCallId: id, toolName: "bash", isError: false, textLength: 2 }],
		},
	];
}

function readResultMsg(toolName: string, body: string): TestMessage[] {
	const id = `c${callSeq++}`;
	return [
		{ role: "assistant", stopReason: "toolUse", toolCalls: [{ id, name: toolName, arguments: { file_path: "/etc/app/config.env" } }] },
		{
			role: "toolResult",
			text: body,
			toolResults: [{ toolCallId: id, toolName, isError: false, textLength: body.length }],
		},
	];
}

/** A long synthetic log body (>50 normalised tokens), identical every time it is "read". */
const LOG_BODY = Array.from(
	{ length: 30 },
	(_, i) =>
		`[2026-01-15 10:${String(i).padStart(2, "0")}:00] level=info worker=request id=${1000 + i} completed status=ok latency=12ms duration=3s code=E0`,
).join("\n");

/** Seed `count` sibling sessions sharing CWD, each built by `mk`. */
async function seedSessions(db: AsyncDatabase, mk: (sessionId: string) => TestMessage[], count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		await insertSession(db, `sim-${i}`, `/tmp/sim-${i}.jsonl`, CWD);
		await insertMessages(db, `sim-${i}`, mk(`sim-${i}`));
	}
}

async function runAllSessions(db: AsyncDatabase, count: number): Promise<void> {
	const fw = mockFramework(db);
	await fw.register(similarityClusterAnalyzer);
	for (let i = 0; i < count; i++) {
		const summary = await fw.run(`sim-${i}`, {});
		assert.equal(summary.errors.length, 0, summary.errors.join("; "));
	}
}

interface ClusterContent {
	session_id: string;
	scope: string;
	sessions_scanned: number;
	clusters: Array<{
		detector: string;
		size: number;
		avg_similarity: number;
		exact: boolean;
		members: Array<{ session_id: string; message_id: string; excerpt: string }>;
	}>;
	cluster_count: number;
	improvement_proposals: Array<{ title: string; severity: string; target_type: string; evidence: string }>;
}

// ─────────────────────────── tests ───────────────────────────

describe("similarity-cluster component tests", () => {
	it("clusters the same repeated correction across sessions and materialises a standing-instruction proposal", async () => {
		const { db, close } = await tempDb();
		try {
			await seedSessions(db, () => promptOnlyMessages(), 3);
			await runAllSessions(db, 3);

			const nodes = await readAnalyzerNodes(db, ANALYZER_ID);
			assert.equal(nodes.length, 3, "one node per session");
			assert.equal(nodes[0]!.node_kind, "proposal", "a size-3 correction cluster proposes");

			const content = JSON.parse(nodes[0]!.content_json) as ClusterContent;
			assert.equal(content.scope, "repo", "siblings were pooled");
			assert.equal(content.sessions_scanned, 3);
			const promptClusters = content.clusters.filter((c) => c.detector === "user_prompt");
			assert.ok(promptClusters.length >= 1, "the repeated prompt clustered");
			const top = promptClusters[0]!;
			assert.equal(top.exact, true);
			assert.equal(top.size, 3);
			assert.equal(new Set(top.members.map((m) => m.session_id)).size, 3, "members span all three sessions");

			assert.equal(content.improvement_proposals.length, 1);
			const prop = content.improvement_proposals[0]!;
			assert.match(prop.title, /correction/i);
			assert.equal(prop.severity, "correction", "re-typed corrections are friction, not suggestions");
			assert.equal(prop.target_type, "agents_md");

			// Evidence trail: anchors to the analysed session AND each member session.
			const edges = await nodeEdges(db, nodes[0]!.id);
			assert.equal(edges.filter((e) => e["edge_kind"] === "anchors" && e["to_ref_kind"] === "session").length, 3);
			assert.ok(edges.some((e) => e["edge_kind"] === "produces"), "proposal node produces its proposal");

			const proposals = await sessionProposals(db, "sim-0", ANALYZER_ID);
			assert.equal(proposals.length, 1);
			assert.equal(proposals[0]!.status, "open");
			assert.equal(proposals[0]!.severity, "correction");
		} finally {
			await close();
		}
	});

	it("detects exact tool-call repetition across sessions as workflow signal", async () => {
		const { db, close } = await tempDb();
		try {
			await seedSessions(
				db,
				(sid) => [
					{ role: "user", text: `${sid}: kickoff for the ${sid === "sim-0" ? "websocket" : sid === "sim-1" ? "storage" : "scheduler"} module, unique scope each time` },
					...bashCallMsg("git diff --name-only HEAD~1 --stat"),
				],
				3,
			);
			await runAllSessions(db, 3);

			const nodes = await readAnalyzerNodes(db, ANALYZER_ID);
			assert.ok(nodes.every((n) => n.node_kind === "proposal"), "workflow cluster proposes per session");
			const content = JSON.parse(nodes[0]!.content_json) as ClusterContent;
			const callCluster = content.clusters.find((c) => c.detector === "tool_call");
			assert.ok(callCluster, "tool-call domain detected");
			assert.equal(callCluster!.exact, true);
			assert.equal(callCluster!.size, 3);
			assert.ok(callCluster!.members[0]!.excerpt.includes("bash command git diff"), "excerpt shows the normalised stream");
			assert.ok(callCluster!.members[0]!.excerpt.includes("bash command git diff"), "excerpt shows the normalised stream");
			const skillProposal = content.improvement_proposals.find((p) => p.target_type === "skill");
			assert.ok(skillProposal, "the tool-call cluster proposes a skill");

			const proposals = await sessionProposals(db, "sim-0", ANALYZER_ID);
			assert.equal(proposals.length, 1);
			assert.equal(proposals[0]!.target_type, "skill");
		} finally {
			await close();
		}
	});

	it("detects identical tool-result bodies fetched in every session", async () => {
		const { db, close } = await tempDb();
		try {
			await seedSessions(
				db,
				(sid) => [
					{ role: "user", text: `session ${sid} asks something unique and unrelated to anything else here` },
					...readResultMsg("read", LOG_BODY),
				],
				3,
			);
			await runAllSessions(db, 3);

			const nodes = await readAnalyzerNodes(db, ANALYZER_ID);
			const content = JSON.parse(nodes[0]!.content_json) as ClusterContent;
			const resultCluster = content.clusters.find((c) => c.detector === "tool_result");
			assert.ok(resultCluster, "tool-result domain detected");
			assert.equal(resultCluster!.exact, true);
			assert.equal(resultCluster!.size, 3);
			assert.ok(content.improvement_proposals.length >= 1, "the cache-hint proposal fires");
		} finally {
			await close();
		}
	});

	it("stays quiet when nothing repeats", async () => {
		const { db, close } = await tempDb();
		try {
			await seedSessions(
				db,
				(sid) => {
					const topics: Record<string, string> = {
						"sim-0": "investigate the flaky websocket reconnect handshake timeout in the gateway",
						"sim-1": "measure why storage compaction slows writes during nightly vacuum runs",
					};
					return promptOnlyMessages().map((m) => (m.role === "user" ? { ...m, text: `${sid}: please ${topics[sid]}` } : m));
				},
				2,
			);
			await runAllSessions(db, 2);

			const nodes = await readAnalyzerNodes(db, ANALYZER_ID);
			assert.equal(nodes.length, 2, "distinct sessions are still analysed");
			for (const n of nodes) {
				assert.equal(n.node_kind, "metric", "nothing recurred → clean metric node");
				const content = JSON.parse(n.content_json) as ClusterContent;
				assert.equal(content.cluster_count, 0);
				assert.equal(content.improvement_proposals.length, 0);
			}
			const proposals = await sessionProposals(db, "sim-0", ANALYZER_ID);
			assert.equal(proposals.length, 0, "no proposal materialised for distinct prompts");
		} finally {
			await close();
		}
	});

	it("re-running the same recipe is idempotent through the full pipeline", async () => {
		const { db, close } = await tempDb();
		try {
			// Two sessions sharing the cwd so cross-session pooling is exercised:
			// the first run folds the sibling's item fingerprint into identity.
			await insertSession(db, "sim-a", "/tmp/sim-a.jsonl", CWD);
			await insertMessages(db, "sim-a", promptOnlyMessages());
			await insertSession(db, "sim-b", "/tmp/sim-b.jsonl", CWD);
			await insertMessages(db, "sim-b", promptOnlyMessages());

			const fw = mockFramework(db);
			await assertPlainRerunIsNoOpFill(fw, similarityClusterAnalyzer, "sim-a", () => readAnalyzerNodes(db, ANALYZER_ID));
		} finally {
			await close();
		}
	});

	it("changing config marks units stale for the config reason and revises beside their predecessors", async () => {
		const { db, close } = await tempDb();
		try {
			await seedSessions(db, () => promptOnlyMessages(), 2);

			const fw = mockFramework(db);
			await fw.register(similarityClusterAnalyzer);
			await fw.run("sim-0", {});
			const before = await readAnalyzerNodes(db, ANALYZER_ID);
			assert.equal(before.length, 1);

			// A higher minimum cluster size changes the resolved fingerprint →
			// stale/config; the revise recomputes beside its predecessor.
			const revisedFw = mockFrameworkWithOverrides(db, ANALYZER_ID, { minClusterSize: 5 });
			await revisedFw.register(similarityClusterAnalyzer);
			const after = await reviseBesidePredecessor(db, revisedFw, ANALYZER_ID, "sim-0", before);

			// Under minClusterSize=5 the size-3 cluster no longer proposes.
			const revisedNode = after.find((n) => !before.some((b) => b.input_key === n.input_key))!;
			const revised = JSON.parse(revisedNode.content_json) as ClusterContent;
			assert.equal(revised.improvement_proposals.length, 0, "the gate now holds the proposal back");
		} finally {
			await close();
		}
	});
});
