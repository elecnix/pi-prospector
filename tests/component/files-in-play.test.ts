/**
 * Component tests for the files-in-play analyzer, exercised end-to-end
 * through the real AnalyzerFramework (issue #103). No real session data, no
 * network: hand-written synthetic rows. The analyzer never touches the LLM
 * seam; the mock LLM exists only to satisfy the framework's construction and
 * prove the analyzer stays deterministic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages, type TestMessage } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { filesInPlayAnalyzer } from "../../src/analyze/analyzers/files-in-play/index.js";
import { FILES_IN_PLAY_PROPERTIES } from "../../src/analyze/analyzers/files-in-play/index.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";

// ─────────────────────────── fixtures ───────────────────────────

let callSeq = 0;
function toolTouch(role: "assistant", name: string, args: Record<string, unknown>): Omit<TestMessage, "role"> {
	return {
		role: "assistant",
		stopReason: "toolUse",
		toolCalls: [{ id: `c${callSeq++}`, name, arguments: args }],
	};
}

/** Heavy churn: five rounds of read→edit→read→edit cycling over two files. */
function churningSessionMessages(): TestMessage[] {
	const msgs: TestMessage[] = [
		{ role: "user", text: "Please fix the login flow and the session handling." },
	];
	for (let round = 0; round < 5; round++) {
		for (const [name, args] of [
			["read", { file_path: "src/auth/login.ts" }] as const,
			["edit", { file_path: "src/auth/login.ts" }] as const,
			["read", { path: "src/auth/session.ts" }] as const,
			["edit", { path: "src/auth/session.ts" }] as const,
		]) {
			const call = toolTouch("assistant", name, args);
			msgs.push(call);
			msgs.push({
				role: "toolResult",
				text: "ok",
				toolResults: [{ toolCallId: call.toolCalls![0]!.id!, toolName: name, isError: false, textLength: 2 }],
			});
		}
	}
	return msgs;
}

/** Linear work: every file is touched briefly and never revisited. */
function linearSessionMessages(): TestMessage[] {
	const msgs: TestMessage[] = [{ role: "user", text: "Scaffold twelve small modules." }];
	for (let i = 0; i < 12; i++) {
		const read = toolTouch("assistant", "read", { file_path: `src/module${i}/index.ts` });
		msgs.push(read);
		msgs.push({
			role: "toolResult",
			text: "ok",
			toolResults: [{ toolCallId: read.toolCalls![0]!.id!, toolName: "read", isError: false, textLength: 2 }],
		});
	}
	return msgs;
}

function newFramework(db: import("better-sqlite3").Database) {
	return new AnalyzerFramework({
		db,
		llm: createMockLLM({ responder: () => "unused by this analyzer" }).caller,
		modelTiers: DEFAULT_MODEL_TIERS,
	});
}

/** Same, but with per-analyzer config overrides (everything the user sets is config). */
function newFrameworkWithOverrides(db: import("better-sqlite3").Database, overrides: Record<string, unknown>) {
	return new AnalyzerFramework({
		db,
		llm: createMockLLM({ responder: () => "unused by this analyzer" }).caller,
		modelTiers: DEFAULT_MODEL_TIERS,
		configOverrides: { "files-in-play": overrides },
	});
}

interface NodeRow extends Record<string, unknown> {
	id: string;
	node_kind: string;
	input_key: string;
	output_key: string;
	content_json: string;
}

async function readNodes(db: import("better-sqlite3").Database): Promise<NodeRow[]> {
	return (await db
		.prepare("SELECT id, node_kind, input_key, output_key, content_json FROM analysis_nodes WHERE analyzer_id = ?")
		.all("files-in-play")) as unknown as NodeRow[];
}

interface ChurnContent {
	session_id: string;
	distinct_files: number;
	interaction_count: number;
	read_count: number;
	edit_count: number;
	write_count: number;
	reread_events: number;
	edit_reread_cycles: number;
	churn_windows: number;
	churning_windows: number;
	churn_score: number;
	top_files: Array<{ path: string; reads: number; edits: number; writes: number; rereads: number; cycles: number }>;
	improvement_proposals: Array<{ title: string; severity: string; evidence: string }>;
}

// ─────────────────────────── tests ───────────────────────────

describe("files-in-play component tests", () => {
	it("detects churn end-to-end, emits a proposal node, and materialises it", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "churn-e2e");
			await insertMessages(db, "churn-e2e", churningSessionMessages());

			const fw = newFramework(db);
			await fw.register(filesInPlayAnalyzer);
			const summary = await fw.run("churn-e2e", {});
			assert.equal(summary.errors.length, 0, `run should have no errors: ${summary.errors.join("; ")}`);

			const nodes = await readNodes(db);
			assert.equal(nodes.length, 1, "one node per session");

			const node = nodes[0]!;
			assert.equal(node.node_kind, "proposal", "clearing both thresholds makes this a proposal node");
			void FILES_IN_PLAY_PROPERTIES; // schema declared; emission checked field-by-field below

			const content = JSON.parse(node.content_json) as ChurnContent;
			assert.equal(content.session_id, "churn-e2e");
			assert.equal(content.distinct_files, 2);
			assert.equal(content.interaction_count, 20);
			assert.equal(content.read_count, 10);
			assert.equal(content.edit_count, 10);
			assert.equal(content.reread_events, 8, "each file's 4 later reads are re-reads");
			assert.equal(content.edit_reread_cycles, 8, "each edit-then-read pair completes one cycle");
			assert.equal(content.churn_score, 1, "every window of a pure cycling session churns");
			assert.equal(content.top_files.length, 2, "both churned files are named with counts");
			for (const f of content.top_files) {
				assert.equal(f.writes, 0);
				assert.ok(f.rereads > 0 && f.cycles > 0, `${f.path} carries reread/cycle counts`);
			}
			assert.equal(content.improvement_proposals.length, 1);
			assert.match(content.improvement_proposals[0]!.title, /read-edit cycling/i);

			// Evidence trail: session anchor + anchors on the turns that re-touched
			// files already in play, plus the produces edge into the fast store.
			const edges = (await db
				.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ?")
				.all(node.id)) as unknown as Array<Record<string, unknown>>;
			const sessionAnchors = edges.filter((e) => e["edge_kind"] === "anchors" && e["to_ref_kind"] === "session");
			const messageAnchors = edges.filter((e) => e["edge_kind"] === "anchors" && e["to_ref_kind"] === "message");
			assert.equal(sessionAnchors.length, 1, "anchored to the session");
			assert.ok(messageAnchors.length >= 3, "the churning turns anchor the finding");
			const produced = edges.find((e) => e["edge_kind"] === "produces");
			assert.ok(produced, "proposal node must produce its proposal");

			const proposals = (await db
				.prepare("SELECT * FROM proposals WHERE session_id = ? AND analyzer_id = ?")
				.all("churn-e2e", "files-in-play")) as unknown as Array<Record<string, unknown>>;
			assert.equal(proposals.length, 1, "exactly one materialised proposal");
			assert.equal(proposals[0]!.status, "open");
			assert.equal(proposals[0]!.severity, "waste");
		} finally {
			await close();
		}
	});

	it("re-running the same recipe is idempotent: no new nodes, keys unchanged", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "churn-idem");
			await insertMessages(db, "churn-idem", churningSessionMessages());

			const fw = newFramework(db);
			await fw.register(filesInPlayAnalyzer);

			const first = await fw.run("churn-idem", {});
			assert.equal(first.errors.length, 0);
			const before = await readNodes(db);
			assert.equal(before.length, 1);

			const second = await fw.run("churn-idem", {});
			assert.equal(second.errors.length, 0);
			assert.equal(second.nodesProduced, 0, "second plain fill must produce nothing");
			assert.equal(second.nodesSkipped, 1, "the existing unit is current");

			const after = await readNodes(db);
			assert.deepEqual(after.map((n) => [n.input_key, n.output_key]), before.map((n) => [n.input_key, n.output_key]));
		} finally {
			await close();
		}
	});

	it("linear work over fresh files stays a clean metric node with no proposals", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "churn-linear");
			await insertMessages(db, "churn-linear", linearSessionMessages());

			const fw = newFramework(db);
			await fw.register(filesInPlayAnalyzer);
			const summary = await fw.run("churn-linear", {});
			assert.equal(summary.errors.length, 0);

			const nodes = await readNodes(db);
			assert.equal(nodes.length, 1, "a clean session is still analysed");
			assert.equal(nodes[0]!.node_kind, "metric", "no proposals below threshold");

			const content = JSON.parse(nodes[0]!.content_json) as ChurnContent;
			assert.equal(content.distinct_files, 12);
			assert.equal(content.reread_events, 0);
			assert.equal(content.churn_score, 0);
			assert.equal(content.improvement_proposals.length, 0);

			const proposals = (await db
				.prepare("SELECT COUNT(*) AS n FROM proposals WHERE session_id = ? AND analyzer_id = ?")
				.get("churn-linear", "files-in-play")) as unknown as { n: number };
			assert.equal(proposals.n, 0, "nothing materialised for linear work");
		} finally {
			await close();
		}
	});

	it("changing config marks nodes stale for the `config` reason and revises beside them", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "churn-config");
			await insertMessages(db, "churn-config", churningSessionMessages());

			const fw = newFramework(db);
			await fw.register(filesInPlayAnalyzer);

			await fw.run("churn-config", {});
			const before = await readNodes(db);
			assert.equal(before.length, 1);

			// A tighter window changes the resolved config fingerprint → the unit
			// goes stale for the `config` reason; the revise run recomputes it,
			// preserving the old version as lineage.
			const narrowed = newFrameworkWithOverrides(db, { windowSize: 4 });
			await narrowed.register(filesInPlayAnalyzer);
			const summary = await narrowed.run("churn-config", { revise: ["config"] });
			assert.equal(summary.errors.length, 0);
			assert.equal(summary.nodesRevised, 1, "the unit was revised under new config");

			const after = await readNodes(db);
			assert.equal(after.length, 2, "old version preserved as lineage beside the revision");
			const revised = after.find((n) => n.input_key !== before[0]!.input_key);
			assert.ok(revised, "revised node carries a new recipe identity");

			const edges = (await db
				.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ? AND edge_kind = 'revises'")
				.all(revised!.id)) as unknown as Array<Record<string, unknown>>;
			assert.equal(edges.length, 1, "a revises edge links the revision to its predecessor");

			// The revision itself is idempotent under its own recipe.
			const rerun = await narrowed.run("churn-config", {});
			assert.equal(rerun.nodesProduced, 0, "revised unit is current afterwards");
		} finally {
			await close();
		}
	});
});
