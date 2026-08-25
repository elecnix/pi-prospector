/**
 * Component tests for the uncompleted-leads analyzer, exercised end-to-end
 * through the real AnalyzerFramework. No real session data, no network: hand
 * -written synthetic rows whose result texts carry real path/URL/command shapes.
 *
 * The analyzer itself never touches the LLM seam; the mock LLM exists only to
 * satisfy the framework's construction and prove the analyzer stays deterministic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages, type TestMessage } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { uncompletedLeadsAnalyzer } from "../../src/analyze/analyzers/uncompleted-leads/index.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";

// ─────────────────────────── fixtures ───────────────────────────

function bashCall(command: string): TestMessage["toolCalls"] {
	return [{ name: "bash", arguments: { command } }];
}

function readCall(path: string): TestMessage["toolCalls"] {
	return [{ name: "read", arguments: { file_path: path } }];
}

/**
 * A session that surfaces five file paths in one grep result, plus a URL and a
 * suggested command; only ONE of the paths is ever read afterwards. The three
 * unpursued paths clear the default per-class threshold, so the run should end
 * with a materialised proposal.
 */
function leadSessionMessages(): TestMessage[] {
	return [
		{ role: "user", text: "The build is failing, please investigate." },
		{
			role: "assistant",
			text: "Let me search for the failing symbols.",
			toolCalls: bashCall("grep -rn renderHeader src/"),
		},
		{
			role: "toolResult",
			text:
				"src/ui/header.ts:12: function renderHeader() {\n" +
				"src/ui/footer.ts:8: function renderFooter() {\n" +
				"src/theme/palette.ts:40: export const headerColors =\n" +
				"src/layout/grid.ts:3: export const headerSpan =\n" +
				"failing test references https://docs.example.com/render/guidelines\n" +
				"Run `npm rebuild` if native deps are stale.",
			toolResults: [{ toolName: "bash", isError: false, textLength: 260 }],
		},
		{ role: "user", text: "thanks, keep going." },
		{
			role: "assistant",
			text: "Reading the header file only.",
			toolCalls: readCall("src/ui/header.ts"),
		},
		{ role: "user", text: "ok stop here." },
	];
}

/** A session with tool traffic but nothing lead-shaped: must stay a clean metric. */
function cleanSessionMessages(): TestMessage[] {
	return [
		{ role: "user", text: "what time is it?" },
		{
			role: "assistant",
			text: "Checking.",
			toolCalls: bashCall("date -u +%H:%M"),
		},
		{
			role: "toolResult",
			text: "14:23 UTC",
			toolResults: [{ toolName: "bash", isError: false, textLength: 9 }],
		},
	];
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
		configOverrides: { "uncompleted-leads": overrides },
	});
}

interface NodeRow extends Record<string, unknown> {
	id: string;
	node_kind: string;
	input_key: string;
	output_key: string;
	content_json: string;
}

async function readLeadNodes(db: import("better-sqlite3").Database): Promise<NodeRow[]> {
	return (await db
		.prepare("SELECT id, node_kind, input_key, output_key, content_json FROM analysis_nodes WHERE analyzer_id = ?")
		.all("uncompleted-leads")) as unknown as NodeRow[];
}

// ─────────────────────────── tests ───────────────────────────

describe("uncompleted-leads component test", () => {
	it("detects unpursued leads end-to-end and materialises a recurrence-gated proposal", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "leads-e2e");
			await insertMessages(db, "leads-e2e", leadSessionMessages());

			const fw = newFramework(db);
			await fw.register(uncompletedLeadsAnalyzer);
			const summary = await fw.run("leads-e2e", {});
			assert.equal(summary.errors.length, 0, `run should have no errors: ${summary.errors.join("; ")}`);

			const nodes = await readLeadNodes(db);
			assert.equal(nodes.length, 1, "one node per session");

			const node = nodes[0]!;
			assert.equal(node.node_kind, "proposal", "recurrence above threshold makes this a proposal node");

			const content = JSON.parse(node.content_json) as {
				lead_count: number;
				completed_count: number;
				uncompleted_count: number;
				uncompleted_by_type: Record<string, number>;
				truncated_leads: number;
				improvement_proposals: Array<{ title: string; severity: string }>;
			};

			assert.equal(content.completed_count, 1, "only src/ui/header.ts was read later");
			assert.ok(content.uncompleted_count >= 4, `expected >=4 uncompleted (3 paths + URL), got ${content.uncompleted_count}`);
			assert.equal(content.uncompleted_by_type["path"], 3, "three unpursued paths");
			assert.equal(content.truncated_leads, 0);

			// The path class cleared its threshold → exactly one embedded proposal.
			assert.equal(content.improvement_proposals.length, 1);
			assert.equal(content.improvement_proposals[0]?.severity, "waste");

			// Evidence trail: session anchor + an anchor on each unpursued lead's
			// source message, plus the produces edge into the fast store.
			const edges = (await db
				.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ?")
				.all(node.id)) as unknown as Array<Record<string, unknown>>;
			const sessionAnchors = edges.filter((e) => e["edge_kind"] === "anchors" && e["to_ref_kind"] === "session");
			const messageAnchors = edges.filter((e) => e["edge_kind"] === "anchors" && e["to_ref_kind"] === "message");
			assert.equal(sessionAnchors.length, 1, "anchored to the session");
			assert.equal(messageAnchors.length, 1, "the single grep-result message carries every uncompleted lead");
			const produced = edges.find((e) => e["edge_kind"] === "produces");
			assert.ok(produced, "proposal node must produce its proposal");

			const proposals = (await db
				.prepare("SELECT * FROM proposals WHERE session_id = ? AND analyzer_id = ?")
				.all("leads-e2e", "uncompleted-leads")) as unknown as Array<Record<string, unknown>>;
			assert.equal(proposals.length, 1, "exactly one materialised proposal");
			assert.match(String(proposals[0]!.title), /never opened/i);
			assert.equal(proposals[0]!.status, "open");
		} finally {
			await close();
		}
	});

	it("re-running the same recipe is idempotent: no new nodes, keys unchanged", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "leads-idem");
			await insertMessages(db, "leads-idem", leadSessionMessages());

			const fw = newFramework(db);
			await fw.register(uncompletedLeadsAnalyzer);

			const first = await fw.run("leads-idem", {});
			assert.equal(first.errors.length, 0);
			const before = await readLeadNodes(db);
			assert.equal(before.length, 1);

			const second = await fw.run("leads-idem", {});
			assert.equal(second.errors.length, 0);
			assert.equal(second.nodesProduced, 0, "second plain fill must produce nothing");
			assert.equal(second.nodesSkipped, 1, "the existing unit is current");

			const after = await readLeadNodes(db);
			assert.deepEqual(after.map((n) => [n.input_key, n.output_key]), before.map((n) => [n.input_key, n.output_key]));
		} finally {
			await close();
		}
	});

	it("a session with tool traffic but no lead shapes still gets a clean metric node", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "leads-clean");
			await insertMessages(db, "leads-clean", cleanSessionMessages());

			const fw = newFramework(db);
			await fw.register(uncompletedLeadsAnalyzer);
			const summary = await fw.run("leads-clean", {});
			assert.equal(summary.errors.length, 0);

			const nodes = await readLeadNodes(db);
			assert.equal(nodes.length, 1, "a clean session is still analysed");
			assert.equal(nodes[0]!.node_kind, "metric", "no proposals below threshold");

			const content = JSON.parse(nodes[0]!.content_json) as { lead_count: number; improvement_proposals: unknown[] };
			assert.equal(content.lead_count, 0);
			assert.equal(content.improvement_proposals.length, 0);
		} finally {
			await close();
		}
	});

	it("changing config marks nodes stale for the `config` reason and revises beside them", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "leads-config");
			await insertMessages(db, "leads-config", leadSessionMessages());

			const fw = newFramework(db);
			await fw.register(uncompletedLeadsAnalyzer);

			await fw.run("leads-config", {});
			const before = await readLeadNodes(db);
			assert.equal(before.length, 1);

			// Narrowing to URLs-only changes the resolved config fingerprint → the
			// unit goes stale for the `config` reason; the revise run recomputes it,
			// preserving the old version as lineage.
			const narrowed = newFrameworkWithOverrides(db, { enabledTypes: ["url"] });
			await narrowed.register(uncompletedLeadsAnalyzer);
			const summary = await narrowed.run("leads-config", { revise: ["config"] });
			assert.equal(summary.errors.length, 0);
			assert.equal(summary.nodesRevised, 1, "the unit was revised under new config");

			const after = await readLeadNodes(db);
			assert.equal(after.length, 2, "old version preserved as lineage beside the revision");
			const revised = after.find((n) => n.input_key !== before[0]!.input_key);
			assert.ok(revised, "revised node carries a new recipe identity");

			const edges = (await db
				.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ? AND edge_kind = 'revises'")
				.all(revised!.id)) as unknown as Array<Record<string, unknown>>;
			assert.equal(edges.length, 1, "a revises edge links the revision to its predecessor");
		} finally {
			await close();
		}
	});
});
