import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openAsyncDatabase, type AsyncDatabase } from "../../src/db/async-db.js";
import { migrate } from "../../src/db/schema.js";
import { insertNode, insertEdge } from "../../src/db/analysis-queries.js";
import { insertSession } from "./helpers.js";
import { prospectProposals } from "../../src/commands/proposals.js";
import { registerProspectTool } from "../../src/commands/tool.js";
import type { ExtensionAPI, ExtensionCommandContext, ToolResult } from "../../src/pi-stubs.js";
import type { Proposal } from "../../src/types.js";

/**
 * Component test for issue #107 (display-time grouping of proposals under the
 * general proposal that generalises them): a real SQLite analysis graph built
 * by hand — a session-overview-style summary node that `consumes` two upstream
 * turn nodes whose `produces` edges yield the specific proposals — then the
 * slash command and the `prospect` tool's `list_proposals` action are run over
 * it. Synthetic data only; no LLM, no network.
 */

const ctx = {
	modelRegistry: { find: () => undefined, getAll: () => [], getAvailable: () => [], getApiKeyAndHeaders: async () => ({ ok: false, error: "test" }) },
	hasUI: false,
	ui: { notify: (m: string) => notes.push(m) },
} as unknown as ExtensionCommandContext;

const notes: string[] = [];
let toolExec: ((id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: unknown, c: ExtensionCommandContext) => Promise<ToolResult>) | undefined;

const fakePi: ExtensionAPI = {
	registerCommand: () => {},
	registerTool: (tool) => {
		if (tool.name === "prospect") toolExec = tool.execute as typeof toolExec;
	},
	registerFlag: () => {},
	getFlag: () => undefined,
	on: () => {},
};

const SESS = "sess-grouping-1";
// Graph fixture ids. Node-targeting edges reference the target's output_key,
// exactly as the framework writes them (see getNodeByOutputKey).
const SUMMARY_NODE = "node-summary";
const SUMMARY_2_NODE = "node-summary-2";
const TURN_A = "node-turn-a";
const TURN_B = "node-turn-b";
const OK_TURN_A = "okkey-turn-a";
const OK_TURN_B = "okkey-turn-b";
const P_GENERAL = "prop-general";
const P_GENERAL_2 = "prop-general-2";
const P_SPECIFIC_A = "prop-specific-a";
const P_SPECIFIC_B = "prop-specific-b";

let tmpDir: string;
let dbPath: string;
let db: AsyncDatabase;

before(async () => {
	registerProspectTool(fakePi);
	assert.ok(toolExec, "prospect tool must register");
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prospector-grouping-"));
	dbPath = path.join(tmpDir, "grouping.db");
	process.env["PROSPECTOR_DB_PATH"] = dbPath;
	process.env["PROSPECTOR_SESSIONS_DIR"] = tmpDir; // no sessions to scan; we only list
	db = await openAsyncDatabase(dbPath);
	await migrate(db);

	await insertSession(db, SESS);
	const now = new Date().toISOString();
	async function addNode(id: string, analyzerId: string, outputKey: string, nodeKind = "summary"): Promise<void> {
		await insertNode(db, {
			id,
			sessionId: SESS,
			analyzerId,
			analyzerVersionId: `${analyzerId}-v1`,
			configId: `cfg-${id}`,
			runId: null,
			nodeKind,
			contentJson: "{}",
			sourceSetHash: `ssh-${id}`,
			inputKey: `ik-${id}`,
			outputKey,
			createdAt: now,
		});
	}
	// Two session-level synthesis nodes; both consume the turn nodes below.
	await addNode(SUMMARY_NODE, "session-overview", "okkey-summary", "summary");
	await addNode(SUMMARY_2_NODE, "failure-modes", "okkey-summary-2", "proposal");
	await addNode(TURN_A, "turn-pair-core", OK_TURN_A, "metric");
	await addNode(TURN_B, "turn-pair-core", OK_TURN_B, "metric");

	// summary --consumes--> okkey-turn-a / okkey-turn-b (by output key).
	await insertEdge(db, { fromNodeId: SUMMARY_NODE, toRefKind: "analysis_node", toRefId: OK_TURN_A, edgeKind: "consumes", ordinal: 0 });
	await insertEdge(db, { fromNodeId: SUMMARY_NODE, toRefKind: "analysis_node", toRefId: OK_TURN_B, edgeKind: "consumes", ordinal: 1 });
	// The second summary consumes only turn A → multi-parent support for spec-a.
	await insertEdge(db, { fromNodeId: SUMMARY_2_NODE, toRefKind: "analysis_node", toRefId: OK_TURN_A, edgeKind: "consumes", ordinal: 0 });

	// Turn nodes yielded proposals via `produces`.
	await insertEdge(db, { fromNodeId: TURN_A, toRefKind: "proposal", toRefId: P_SPECIFIC_A, edgeKind: "produces", ordinal: 0 });
	await insertEdge(db, { fromNodeId: TURN_B, toRefKind: "proposal", toRefId: P_SPECIFIC_B, edgeKind: "produces", ordinal: 0 });

	// Proposals: one per node. Both summaries cover more evidence than their
	// nested instances (partial support) — only some consumed nodes produced
	// listed proposals. Distinct created_at values make the ranking deterministic.
	const rows: Array<[string, string | null, string]> = [
		[P_GENERAL, SUMMARY_NODE, "2026-01-01T00:00:04.000Z"],
		[P_GENERAL_2, SUMMARY_2_NODE, "2026-01-01T00:00:01.000Z"],
		[P_SPECIFIC_A, TURN_A, "2026-01-01T00:00:02.000Z"],
		[P_SPECIFIC_B, TURN_B, "2026-01-01T00:00:03.000Z"],
	];
	for (const [id, sourceNode, createdAt] of rows) {
		await db.prepare(
			"INSERT INTO proposals (id, created_at, updated_at, session_id, source_node_id, analyzer_id, target_type, title, severity, summary, status, input_key) " +
				"VALUES (?, ?, ?, ?, ?, ?, 'agents_md', ?, 'friction', ?, 'open', ?)",
		).run(id, createdAt, createdAt, SESS, sourceNode, sourceNode === SUMMARY_NODE ? "session-overview" : sourceNode === SUMMARY_2_NODE ? "failure-modes" : "turn-pair-core", `title ${id}`, `summary ${id}`, `ik-${id}`);
	}
});

after(async () => {
	try {
		await db.close();
		for (const suffix of ["", "-wal", "-shm"]) fs.unlinkSync(dbPath + suffix);
	} catch {
		/* ignore */
	}
	delete process.env["PROSPECTOR_DB_PATH"];
	delete process.env["PROSPECTOR_SESSIONS_DIR"];
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Count full-id occurrences (`id: <pid>`) — titles/summaries embed ids too, so match the id line. */
function countId(out: string, pid: string): number {
	return out.split(`id: ${pid} `).length - 1;
}

describe("display-time proposal grouping (#107)", () => {
	it("walks consumes/produces so the specific proposals nest under their generalizer", async () => {
		notes.length = 0;
		await prospectProposals("", ctx);
		const out = notes.join("\n");
		const generalIdx = out.indexOf(`title ${P_GENERAL}\n`);
		assert.ok(generalIdx >= 0, out);
		// Everything between the general proposal's entry and the next root entry
		// is its nested supports, marked ↳ and indented.
		const rest = out.slice(generalIdx);
		assert.match(rest, /↳[\s\S]*?id: prop-specific-a /);
		assert.match(rest, /↳[\s\S]*?id: prop-specific-b /);
	});

	it("shows a multi-parent child under each parent and keeps every proposal visible", async () => {
		notes.length = 0;
		await prospectProposals("", ctx);
		const out = notes.join("\n");
		// spec-a is consumed by both summaries → rendered under each (additive).
		assert.equal(countId(out, P_SPECIFIC_A), 2, "multi-parent child appears under both parents:\n" + out);
		assert.equal(countId(out, P_SPECIFIC_B), 1, "single-parent child appears exactly once");
		// Nothing dropped: all four proposals still listed.
		for (const pid of [P_GENERAL, P_GENERAL_2, P_SPECIFIC_A, P_SPECIFIC_B]) assert.ok(out.includes(pid));
		assert.equal(countId(out, P_GENERAL), 1);
		assert.equal(countId(out, P_GENERAL_2), 1);
	});

	it("renders partial-support generalizers with whatever resolves", async () => {
		notes.length = 0;
		await prospectProposals("", ctx);
		const out = notes.join("\n");
		const lines = out.split("\n");
		const generalLine = lines.findIndex((l) => l.trim() === `title ${P_GENERAL}`);
		assert.ok(generalLine >= 0, out);
		// The two supports render directly beneath their parent, before the next
		// unindented (root-level) entry begins. Root entries are conciseEntry heads:
		// exactly two leading spaces before the status bracket; nested ones carry
		// the deeper "    ↳ " indent.
		const following = [];
		for (let i = generalLine + 1; i < lines.length; i++) {
			if (/^ {2}\[/.test(lines[i]!)) break; // next top-level entry starts
			following.push(lines[i]!);
		}
		const block = following.join("\n");
		assert.match(block, /↳/);
		assert.ok(block.includes(P_SPECIFIC_A) && block.includes(P_SPECIFIC_B), block);
	});

	it("keeps the JSON details machine-readable: nesting structure, flat shape for ungrouped", async () => {
		const res = await toolExec!("t1", { action: "list_proposals" }, new AbortController().signal, null, ctx);
		const details = res.details as Array<Record<string, unknown>>;
		assert.ok(Array.isArray(details), "details remain an array");
		// Every listed proposal's id reachable exactly once per parent edge:
		// gen(→a,b), gen2(→a) ⇒ roots [gen, gen2], nested a twice, b once.
		const ids = JSON.stringify(details.map((d) => d["id"]));
		assert.deepEqual([...details].map((d) => d["id"]).sort(), ["prop-general", "prop-general-2"]);
		const gen = details.find((d) => d["id"] === "prop-general")!;
		assert.deepEqual(gen["supports"].map((s: { id: string }) => s.id).sort(), ["prop-specific-a", "prop-specific-b"]);
		const gen2 = details.find((d) => d["id"] === "prop-general-2")!;
		assert.deepEqual(gen2["supports"].map((s: { id: string }) => s.id), ["prop-specific-a"]);
		// Grouped rows keep all proposal fields verbatim plus `supports`.
		const row = await db.prepare("SELECT * FROM proposals WHERE id = ?").get(P_GENERAL) as Proposal;
		for (const key of Object.keys(row)) assert.ok(key in gen, `field ${key} preserved`);
		assert.equal(gen["title"], row.title);
	});
});
