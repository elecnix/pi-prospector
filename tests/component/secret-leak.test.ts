/**
 * Component tests for the secret-leak analyzer, exercised end-to-end through
 * the real AnalyzerFramework. No real session data, no network, no LLM (the
 * analyzer is deterministic).
 *
 * These prove the analyzer plans, scans, persists a metric node, is idempotent
 * on re-run, anchors findings to the session and the leaked messages, and never
 * writes the full matched secret into the analysis graph.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages, type TestMessage } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { secretLeakAnalyzer, SECRET_LEAK_DEF, type SecretLeakProperties } from "../../src/analyze/analyzers/secret-leak/index.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";

// Shape-correct, never-live synthetic credentials.
const GITHUB_PAT = "ghp_" + "0".repeat(36);
const PEM_HEADER = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...";

function newFramework(db: import("better-sqlite3").Database) {
	const fw = new AnalyzerFramework({
		db,
		// Unused by this analyzer (deterministic) but required by the framework ctor.
		llm: createMockLLM({ fallback: "" }).caller,
		modelTiers: DEFAULT_MODEL_TIERS,
	});
	fw.register(secretLeakAnalyzer);
	return fw;
}

function readNode(db: import("better-sqlite3").Database): { row: Record<string, unknown>; props: SecretLeakProperties } {
	const rows = db
		.prepare("SELECT * FROM analysis_nodes WHERE analyzer_id = ? ORDER BY created_at ASC")
		.all(SECRET_LEAK_DEF.id) as Array<Record<string, unknown>>;
	assert.ok(rows.length >= 1, "secret-leak analyzer should produce at least one node");
	const row = rows[rows.length - 1]!; // newest (append-only graph)
	const props = JSON.parse(row["content_json"] as string) as SecretLeakProperties;
	return { row, props };
}

describe("secret-leak component test", () => {
	it("detects a secret in a user message, anchors to session and message, and stores no full secret", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "leak-1");
			const ids = insertMessages(db, "leak-1", [
				{ role: "user", text: `here is my token: ${GITHUB_PAT}` },
				{ role: "assistant", text: "got it" },
			] satisfies TestMessage[]);

			const fw = newFramework(db);
			const first = await fw.run("leak-1", { analyzerIds: ["secret-leak"] });
			assert.equal(first.nodesProduced, 1);
			const { row, props } = readNode(db);
			assert.equal(row["node_kind"], "metric");
			assert.equal(first.errors.length, 0);
			assert.equal(props.has_leaks, true);
			assert.equal(props.leak_count, 1);
			assert.equal(props.leaks[0]!.rule_id, "github_pat_classic");
			assert.equal(props.leaks[0]!.message_id, ids[0]);

			// The full secret must not be anywhere in the persisted node content.
			const contentJson = row["content_json"] as string;
			assert.ok(!contentJson.includes(GITHUB_PAT), "full secret must not be persisted");
			assert.ok(!contentJson.includes(GITHUB_PAT.slice(4, -4)), "middle of secret must not be persisted");

			// Anchors: one to the session, one to the leaked message.
			const edges = db
				.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ?")
				.all(row["id"]) as Array<Record<string, unknown>>;
			const anchors = edges.filter((e) => e["edge_kind"] === "anchors");
			assert.equal(anchors.length, 2);
			const targets = anchors.map((e) => `${e["to_ref_kind"]}:${e["to_ref_id"]}`).sort();
			assert.deepEqual(targets, [`message:${ids[0]}`, "session:leak-1"]);
		} finally {
			close();
		}
	});

	it("is idempotent: a second run produces no new node", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "leak-2");
			insertMessages(db, "leak-2", [
				{ role: "user", text: `token ${GITHUB_PAT}` },
			] satisfies TestMessage[]);

			const fw = newFramework(db);
			const first = await fw.run("leak-2", { analyzerIds: ["secret-leak"] });
			assert.equal(first.nodesProduced, 1);
			const second = await fw.run("leak-2", { analyzerIds: ["secret-leak"] });
			assert.equal(second.nodesProduced, 0);
			assert.equal(second.nodesSkipped, 1);

			// Still exactly one node.
			const count = (db
				.prepare("SELECT COUNT(*) as c FROM analysis_nodes WHERE analyzer_id = ?")
				.get(SECRET_LEAK_DEF.id) as { c: number }).c;
			assert.equal(count, 1);
		} finally {
			close();
		}
	});

	it("re-identifies when the session grows new turns and rescans", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "leak-3");
			insertMessages(db, "leak-3", [
				{ role: "user", text: "hello" },
				{ role: "assistant", text: "hi" },
			] satisfies TestMessage[]);

			const fw = newFramework(db);
			const first = await fw.run("leak-3", { analyzerIds: ["secret-leak"] });
			assert.equal(first.nodesProduced, 1);
			// Clean first run.
			{
				const { props } = readNode(db);
				assert.equal(props.leak_count, 0);
			}

			// Append a turn that introduces a secret.
			insertMessages(db, "leak-3", [
				{ role: "user", text: `actually use ${GITHUB_PAT}` },
			] satisfies TestMessage[]);
			const second = await fw.run("leak-3", { analyzerIds: ["secret-leak"] });
			// New message id → new sourceSetHash → re-identified as missing → produced.
			assert.equal(second.nodesProduced, 1, "growing the session should re-trigger the analyzer");

			// Append-only: the clean first node remains; the newest node carries the leak.
			const nodeCount = (db
				.prepare("SELECT COUNT(*) as c FROM analysis_nodes WHERE analyzer_id = ?")
				.get(SECRET_LEAK_DEF.id) as { c: number }).c;
			assert.equal(nodeCount, 2, "a re-identified unit adds a node, leaving the old one as lineage");

			const { props } = readNode(db);
			assert.equal(props.leak_count, 1);
			assert.equal(props.leaks[0]!.rule_id, "github_pat_classic");
		} finally {
			close();
		}
	});

	it("detects a PEM private key inside a tool_result field", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "leak-4");
			const ids = insertMessages(db, "leak-4", [
				{ role: "user", text: "show me the key file" },
				{
					role: "toolResult",
					toolResults: [{ toolName: "read", isError: false, textLength: PEM_HEADER.length }],
				},
			] satisfies TestMessage[]);

			// The helpers' toolResults shape does not carry `text`; inject the PEM into
			// the raw tool_results JSON the way a real transcript would, by writing the
			// row directly with a text field that the detector scans as a raw string.
			// Target the toolResult row by id so the user message is untouched.
			const toolResultId = ids[1]!;
			db.prepare("UPDATE messages SET tool_results = ? WHERE id = ?").run(
				JSON.stringify([{ toolName: "read", isError: false, textLength: PEM_HEADER.length, text: PEM_HEADER }]),
				toolResultId,
			);

			const summary = await newFramework(db).run("leak-4", { analyzerIds: ["secret-leak"] });
			assert.equal(summary.errors.length, 0);
			const { props } = readNode(db);
			assert.equal(props.leak_count, 1);
			assert.equal(props.leaks[0]!.rule_id, "private_key_block");
			assert.equal(props.leaks[0]!.field, "tool_results");
			assert.equal(props.leaks[0]!.message_id, toolResultId);
			assert.ok(!JSON.stringify(props).includes(PEM_HEADER.slice(16, -16)));
		} finally {
			close();
		}
	});

	it("clean session produces a node with has_leaks=false", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "leak-5");
			insertMessages(db, "leak-5", [
				{ role: "user", text: "refactor the helpers please" },
				{ role: "assistant", text: "splitting them by concern" },
			] satisfies TestMessage[]);

			const summary = await newFramework(db).run("leak-5", { analyzerIds: ["secret-leak"] });
			assert.equal(summary.errors.length, 0);
			assert.equal(summary.nodesProduced, 1);
			const { props } = readNode(db);
			assert.equal(props.has_leaks, false);
			assert.equal(props.leak_count, 0);
			// Anchors only to the session (no leaked messages).
			const row = db
				.prepare("SELECT id FROM analysis_nodes WHERE analyzer_id = ?")
				.get(SECRET_LEAK_DEF.id) as { id: string };
			const edges = db
				.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ? AND edge_kind = 'anchors'")
				.all(row.id) as Array<Record<string, unknown>>;
			assert.equal(edges.length, 1);
			assert.equal(edges[0]!["to_ref_kind"], "session");
		} finally {
			close();
		}
	});
});