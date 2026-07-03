/**
 * End-to-end (framework + real SQLite) tests for locally-authored custom
 * analyzers: a disk-loaded analyzer registered via registerAll produces a node,
 * and editing its source (identity-on-edit) makes a re-run revise it — no manual
 * version bump.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tempDb, insertSession, insertMessages, type TempDb } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { registerAll } from "../../src/analyze/defaults.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prospector-custom-"));
});
afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

/** A self-contained deterministic custom analyzer that counts messages. */
function customSource(label: string): string {
	return `export default {
  def: { id: "msg-count", label: ${JSON.stringify(label)}, description: "counts messages", anchorSpan: "full_session", dependencies: [] },
  version: { analyzerId: "msg-count", major: 1, minor: 0, implementationKind: "deterministic" },
  prompts: {},
  defaultConfig: { id: "", analyzerId: "msg-count", configHash: "", configJson: {}, label: "default" },
  plan(ctx) {
    return [{ sources: [{ kind: "session", id: ctx.sessionId }], sourceSetHash: "sset-" + ctx.sessionId, anchorKind: "session", anchorRef: ctx.sessionId }];
  },
  analyze(unit, ctx) {
    const n = ctx.getSessionMessages(ctx.sessionId).length;
    return { nodeKind: "metric", contentJson: { messageCount: n, label: ${JSON.stringify(label)} }, anchorKind: "session", anchorRef: ctx.sessionId, edges: [] };
  }
};
`;
}

function seed(db: import("better-sqlite3").Database, id: string): void {
	insertSession(db, id);
	insertMessages(db, id, [
		{ id: `${id}-m0`, role: "user", text: "hello" },
		{ id: `${id}-m1`, role: "assistant", text: "hi" },
	]);
}

function customNodes(db: import("better-sqlite3").Database): Array<{ input_key: string; content_json: string }> {
	return db
		.prepare("SELECT input_key, content_json FROM analysis_nodes WHERE analyzer_id = 'msg-count' ORDER BY created_at")
		.all() as Array<{ input_key: string; content_json: string }>;
}

async function run(db: import("better-sqlite3").Database, paths: string[], revise: ("config")[] = []): Promise<void> {
	const mock = createMockLLM({ responder: () => "{}", tokensPerCall: 0, costPerCall: 0 });
	const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
	const { customRegistered, errors } = await registerAll(fw, { paths });
	assert.deepEqual(errors, [], JSON.stringify(errors));
	assert.ok(customRegistered.includes("msg-count"), "custom analyzer registered");
	const summary = await fw.run("s1", { revise, analyzerIds: ["msg-count"] });
	assert.equal(summary.errors.length, 0, summary.errors.join("; "));
}

describe("custom analyzer end-to-end", () => {
	it("a disk-loaded custom analyzer produces a node", async () => {
		const t: TempDb = tempDb();
		try {
			seed(t.db, "s1");
			fs.writeFileSync(path.join(tmp, "count.analyzer.mjs"), customSource("v1"));
			await run(t.db, [tmp]);

			const nodes = customNodes(t.db);
			assert.equal(nodes.length, 1);
			const content = JSON.parse(nodes[0]!.content_json);
			assert.equal(content.messageCount, 2);
			assert.equal(content.label, "v1");
		} finally {
			t.close();
		}
	});

	it("editing the analyzer source revises its node under --revise config (identity-on-edit)", async () => {
		const t: TempDb = tempDb();
		try {
			seed(t.db, "s1");
			const file = path.join(tmp, "count.analyzer.mjs");
			fs.writeFileSync(file, customSource("v1"));
			await run(t.db, [tmp]);
			const firstKey = customNodes(t.db)[0]!.input_key;

			// Edit source (behaviour identical count, different label) + bump mtime.
			fs.writeFileSync(file, customSource("v2"));
			const future = new Date(Date.now() + 2000);
			fs.utimesSync(file, future, future);

			// A plain fill sees the unit as `current`? No — the contentHash changed the
			// fingerprint, so the old node is `stale (config)` and a plain fill leaves
			// it; a `config` revise recomputes it into a new node linked by `revises`.
			await run(t.db, [tmp], ["config"]);

			const nodes = customNodes(t.db);
			assert.equal(nodes.length, 2, "edit produced a second (revised) node");
			assert.notEqual(nodes[0]!.input_key, nodes[1]!.input_key, "new recipe → new input_key");
			assert.equal(nodes[0]!.input_key, firstKey);
			assert.equal(JSON.parse(nodes[1]!.content_json).label, "v2");

			// A revises edge links the new node to its predecessor.
			const revEdges = t.db
				.prepare(
					"SELECT COUNT(*) AS c FROM analysis_edges e JOIN analysis_nodes n ON e.from_node_id = n.id " +
						"WHERE n.analyzer_id = 'msg-count' AND e.edge_kind = 'revises'",
				)
				.get() as { c: number };
			assert.equal(revEdges.c, 1);
		} finally {
			t.close();
		}
	});
});
