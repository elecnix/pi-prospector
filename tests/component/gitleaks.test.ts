/**
 * Component tests for the gitleaks analyzer, exercised end-to-end through
 * the real AnalyzerFramework. No real session data, no network, no LLM (the
 * analyzer is deterministic).
 *
 * These prove the analyzer plans, scans, persists a metric node, is idempotent
 * on re-run, anchors findings to the session and the leaked messages, and never
 * writes the full matched secret into the analysis graph.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AsyncDatabase } from "../src/db/async-db.js";
import { tempDb, insertSession, insertMessages, type TestMessage } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { gitleaksAnalyzer, GITLEAKS_DEF, type GitleaksProperties } from "../../src/analyze/analyzers/gitleaks/index.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";

// Shape-correct, never-live synthetic credentials.
const NPM_TOKEN = "npm_" + "a".repeat(36);
// Unquoted: inside a tool_result the text is JSON-encoded, so quotes would be
// escaped (`\"`) and fall outside gitleaks' assignment-context delimiters.
const TELEGRAM_LINE = `telegram_bot_token = 123456789:${"A".repeat(35)}`;

async function newFramework(db: AsyncDatabase) {
	const fw = new AnalyzerFramework({
		db,
		// Unused by this analyzer (deterministic) but required by the framework ctor.
		llm: createMockLLM({ fallback: "" }).caller,
		modelTiers: DEFAULT_MODEL_TIERS,
	});
	await fw.register(gitleaksAnalyzer);
	return fw;
}

async function readNode(db: AsyncDatabase): Promise<{ row: Record<string, unknown>; props: GitleaksProperties }> {
	const rows = await db
		.prepare("SELECT * FROM analysis_nodes WHERE analyzer_id = ? ORDER BY created_at ASC")
		.all(GITLEAKS_DEF.id) as Array<Record<string, unknown>>;
	assert.ok(rows.length >= 1, "gitleaks analyzer should produce at least one node");
	const row = rows[rows.length - 1]!; // newest (append-only graph)
	const props = JSON.parse(row["content_json"] as string) as GitleaksProperties;
	return { row, props };
}

describe("gitleaks component test", () => {
	it("detects a secret in a user message, anchors to session and message, and stores no full secret", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "gl-1");
			const ids = await insertMessages(db, "gl-1", [
				{ role: "user", text: `here is my token: ${NPM_TOKEN}` },
				{ role: "assistant", text: "got it" },
			] satisfies TestMessage[]);

			const fw = await newFramework(db);
			const first = await fw.run("gl-1", { analyzerIds: ["gitleaks"] });
			assert.equal(first.nodesProduced, 1);
			const { row, props } = await readNode(db);
			assert.equal(row["node_kind"], "metric");
			assert.equal(first.errors.length, 0);
			assert.equal(props.has_leaks, true);
			assert.equal(props.leak_count, 1);
			assert.equal(props.leaks[0]!.rule_id, "npm-access-token");
			assert.equal(props.leaks[0]!.message_id, ids[0]);

			// The full secret must not be anywhere in the persisted node content.
			const contentJson = row["content_json"] as string;
			assert.ok(!contentJson.includes(NPM_TOKEN), "full secret must not be persisted");
			assert.ok(!contentJson.includes(NPM_TOKEN.slice(4, -4)), "middle of secret must not be persisted");

			// Anchors: one to the session, one to the leaked message.
			const edges = await db
				.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ?")
				.all(row["id"]) as Array<Record<string, unknown>>;
			const anchors = edges.filter((e) => e["edge_kind"] === "anchors");
			assert.equal(anchors.length, 2);
			const targets = anchors.map((e) => `${e["to_ref_kind"]}:${e["to_ref_id"]}`).sort();
			assert.deepEqual(targets, [`message:${ids[0]}`, "session:gl-1"]);
		} finally {
			await close();
		}
	});

	it("is idempotent: a second run produces no new node", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "gl-2");
			await insertMessages(db, "gl-2", [
				{ role: "user", text: `token ${NPM_TOKEN}` },
			] satisfies TestMessage[]);

			const fw = await newFramework(db);
			const first = await fw.run("gl-2", { analyzerIds: ["gitleaks"] });
			assert.equal(first.nodesProduced, 1);
			const second = await fw.run("gl-2", { analyzerIds: ["gitleaks"] });
			assert.equal(second.nodesProduced, 0);
			assert.equal(second.nodesSkipped, 1);

			// Still exactly one node.
			const count = ((await db
				.prepare("SELECT COUNT(*) as c FROM analysis_nodes WHERE analyzer_id = ?")
				.get(GITLEAKS_DEF.id)) as { c: number }).c;
			assert.equal(count, 1);
		} finally {
			await close();
		}
	});

	it("re-identifies when the session grows new turns and rescans", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "gl-3");
			await insertMessages(db, "gl-3", [
				{ role: "user", text: "hello" },
				{ role: "assistant", text: "hi" },
			] satisfies TestMessage[]);

			const fw = await newFramework(db);
			const first = await fw.run("gl-3", { analyzerIds: ["gitleaks"] });
			assert.equal(first.nodesProduced, 1);
			// Clean first run.
			{
				const { props } = await readNode(db);
				assert.equal(props.leak_count, 0);
			}

			// Append a turn that introduces a secret.
			await insertMessages(db, "gl-3", [
				{ role: "user", text: TELEGRAM_LINE },
			] satisfies TestMessage[]);
			const second = await fw.run("gl-3", { analyzerIds: ["gitleaks"] });
			assert.equal(second.nodesProduced, 1, "growing the session should re-trigger the analyzer");

			// Append-only: the clean first node remains; the newest node carries the leak.
			const nodeCount = ((await db
				.prepare("SELECT COUNT(*) as c FROM analysis_nodes WHERE analyzer_id = ?")
				.get(GITLEAKS_DEF.id)) as { c: number }).c;
			assert.equal(nodeCount, 2, "a re-identified unit adds a node, leaving the old one as lineage");

			const { props } = await readNode(db);
			assert.equal(props.leak_count, 1);
			assert.equal(props.leaks[0]!.rule_id, "telegram-bot-api-token");
		} finally {
			await close();
		}
	});

	it("detects an assignment-context secret inside a tool_result field", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "gl-4");
			const ids = await insertMessages(db, "gl-4", [
				{ role: "user", text: "show me the deploy config" },
				{ role: "toolResult", toolResults: [{ toolName: "read", isError: false, textLength: TELEGRAM_LINE.length }] },
			] satisfies TestMessage[]);

			// The helpers' toolResults shape does not carry `text`; inject the leak
			// into the raw tool_results JSON the way a real transcript would.
			const toolResultId = ids[1]!;
			await db.prepare("UPDATE messages SET tool_results = ? WHERE id = ?").run(
				JSON.stringify([{ toolName: "read", isError: false, textLength: TELEGRAM_LINE.length, text: TELEGRAM_LINE }]),
				toolResultId,
			);

			const summary = await (await newFramework(db)).run("gl-4", { analyzerIds: ["gitleaks"] });
			assert.equal(summary.errors.length, 0);
			const { props } = await readNode(db);
			assert.equal(props.leak_count, 1);
			assert.equal(props.leaks[0]!.rule_id, "telegram-bot-api-token");
			assert.equal(props.leaks[0]!.field, "tool_results");
			assert.equal(props.leaks[0]!.message_id, toolResultId);
			assert.ok(!JSON.stringify(props).includes(TELEGRAM_LINE.slice(20, -20)));
		} finally {
			await close();
		}
	});

	it("clean session produces a node with has_leaks=false", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "gl-5");
			await insertMessages(db, "gl-5", [
				{ role: "user", text: "refactor the helpers please" },
				{ role: "assistant", text: "splitting them by concern" },
			] satisfies TestMessage[]);

			const summary = await (await newFramework(db)).run("gl-5", { analyzerIds: ["gitleaks"] });
			assert.equal(summary.errors.length, 0);
			assert.equal(summary.nodesProduced, 1);
			const { props } = await readNode(db);
			assert.equal(props.has_leaks, false);
			assert.equal(props.leak_count, 0);
			// Anchors only to the session (no leaked messages).
			const row = (await db
				.prepare("SELECT id FROM analysis_nodes WHERE analyzer_id = ?")
				.get(GITLEAKS_DEF.id)) as { id: string };
			const edges = await db
				.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ? AND edge_kind = 'anchors'")
				.all(row.id) as Array<Record<string, unknown>>;
			assert.equal(edges.length, 1);
			assert.equal(edges[0]!["to_ref_kind"], "session");
		} finally {
			await close();
		}
	});
});
