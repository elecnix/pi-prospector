/**
 * Component tests for the detect-secrets analyzer, exercised end-to-end through
 * the real AnalyzerFramework. No real session data, no network, no LLM (the
 * analyzer is deterministic).
 *
 * These prove the analyzer plans, scans, persists a metric node, is idempotent
 * on re-run, anchors findings to the session and the leaked messages, applies
 * its exclusion filters in the live pipeline, and never writes the full
 * matched secret into the analysis graph.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AsyncDatabase } from "../src/db/async-db.js";
import { tempDb, insertSession, insertMessages, type TestMessage } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import {
	detectSecretsAnalyzer,
	DETECT_SECRETS_DEF,
	type DetectSecretsProperties,
} from "../../src/analyze/analyzers/detect-secrets/index.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";

// Shape-correct, never-live synthetic credentials, built by a deterministic
// PRNG over fixed charsets so no contiguous realistic literal exists in source.
function makeRng(seed: number): () => number {
	let a = seed >>> 0;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function pseudo(len: number, seed: number, charset: string): string {
	const rng = makeRng(seed);
	let s = "";
	for (let i = 0; i < len; i++) s += charset[Math.floor(rng() * charset.length)];
	return s;
}
const RANDOM_B64 = pseudo(48, 42, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/-_");
const RANDOM_B64_ALT = pseudo(48, 123, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/-_");
// Unquoted: inside a tool_result the text is JSON-encoded, so quotes would be
// escaped (`\"`) and captured into the candidate value.
const TOOL_RESULT_LINE = `token = ${RANDOM_B64_ALT}`;

async function newFramework(db: AsyncDatabase) {
	const fw = new AnalyzerFramework({
		db,
		// Unused by this analyzer (deterministic) but required by the framework ctor.
		llm: createMockLLM({ fallback: "" }).caller,
		modelTiers: DEFAULT_MODEL_TIERS,
	});
	await fw.register(detectSecretsAnalyzer);
	return fw;
}

async function readNode(
	db: AsyncDatabase,
): Promise<{ row: Record<string, unknown>; props: DetectSecretsProperties }> {
	const rows = await db
		.prepare("SELECT * FROM analysis_nodes WHERE analyzer_id = ? ORDER BY created_at ASC")
		.all(DETECT_SECRETS_DEF.id) as Array<Record<string, unknown>>;
	assert.ok(rows.length >= 1, "detect-secrets analyzer should produce at least one node");
	const row = rows[rows.length - 1]!; // newest (append-only graph)
	const props = JSON.parse(row["content_json"] as string) as DetectSecretsProperties;
	return { row, props };
}

describe("detect-secrets component test", () => {
	it("detects a secret in a user message, anchors to session and message, and stores no full secret", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "ds-1");
			const ids = await insertMessages(db, "ds-1", [
				{ role: "user", text: `here is my key: password = ${RANDOM_B64}` },
				{ role: "assistant", text: "got it" },
			] satisfies TestMessage[]);

			const fw = await newFramework(db);
			const first = await fw.run("ds-1", { analyzerIds: ["detect-secrets"] });
			assert.equal(first.nodesProduced, 1);
			const { row, props } = await readNode(db);
			assert.equal(row["node_kind"], "metric");
			assert.equal(first.errors.length, 0);
			assert.equal(props.has_leaks, true);
			assert.ok(props.leak_count >= 1);
			assert.equal(props.leaks[0]!.rule_id, "keyword-assignment");
			assert.equal(props.leaks[0]!.confidence, "active");
			assert.equal(props.leaks[0]!.message_id, ids[0]);

			// The full secret must not be anywhere in the persisted node content.
			const contentJson = row["content_json"] as string;
			assert.ok(!contentJson.includes(RANDOM_B64), "full secret must not be persisted");
			assert.ok(!contentJson.includes(RANDOM_B64.slice(4, -4)), "middle of secret must not be persisted");

			// Anchors: one to the session, one to the leaked message.
			const edges = await db
				.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ?")
				.all(row["id"]) as Array<Record<string, unknown>>;
			const anchors = edges.filter((e) => e["edge_kind"] === "anchors");
			assert.equal(anchors.length, 2);
			const targets = anchors.map((e) => `${e["to_ref_kind"]}:${e["to_ref_id"]}`).sort();
			assert.deepEqual(targets, [`message:${ids[0]}`, "session:ds-1"]);
		} finally {
			await close();
		}
	});

	it("is idempotent: a second run produces no new node", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "ds-2");
			await insertMessages(db, "ds-2", [
				{ role: "user", text: `key password = ${RANDOM_B64}` },
			] satisfies TestMessage[]);

			const fw = await newFramework(db);
			const first = await fw.run("ds-2", { analyzerIds: ["detect-secrets"] });
			assert.equal(first.nodesProduced, 1);
			const second = await fw.run("ds-2", { analyzerIds: ["detect-secrets"] });
			assert.equal(second.nodesProduced, 0);
			assert.equal(second.nodesSkipped, 1);

			// Still exactly one node.
			const count = ((await db
				.prepare("SELECT COUNT(*) as c FROM analysis_nodes WHERE analyzer_id = ?")
				.get(DETECT_SECRETS_DEF.id)) as { c: number }).c;
			assert.equal(count, 1);
		} finally {
			await close();
		}
	});

	it("re-identifies when the session grows new turns and rescans", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "ds-3");
			await insertMessages(db, "ds-3", [
				{ role: "user", text: "hello" },
				{ role: "assistant", text: "hi" },
			] satisfies TestMessage[]);

			const fw = await newFramework(db);
			const first = await fw.run("ds-3", { analyzerIds: ["detect-secrets"] });
			assert.equal(first.nodesProduced, 1);
			// Clean first run.
			{
				const { props } = await readNode(db);
				assert.equal(props.leak_count, 0);
			}

			// Append a turn that introduces a secret.
			await insertMessages(db, "ds-3", [
				{ role: "user", text: `api_key: ${RANDOM_B64}` },
			] satisfies TestMessage[]);
			const second = await fw.run("ds-3", { analyzerIds: ["detect-secrets"] });
			assert.equal(second.nodesProduced, 1, "growing the session should re-trigger the analyzer");

			// Append-only: the clean first node remains; the newest node carries the leak.
			const nodeCount = ((await db
				.prepare("SELECT COUNT(*) as c FROM analysis_nodes WHERE analyzer_id = ?")
				.get(DETECT_SECRETS_DEF.id)) as { c: number }).c;
			assert.equal(nodeCount, 2, "a re-identified unit adds a node, leaving the old one as lineage");

			const { props } = await readNode(db);
			assert.equal(props.leak_count, 1);
			assert.equal(props.leaks[0]!.rule_id, "keyword-assignment");
			assert.equal(props.leaks[0]!.confidence, "active");
		} finally {
			await close();
		}
	});

	it("detects a candidate inside a tool_result field", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "ds-4");
			const ids = await insertMessages(db, "ds-4", [
				{ role: "user", text: "show me the deploy output" },
				{ role: "toolResult", toolResults: [{ toolName: "bash", isError: false, textLength: TOOL_RESULT_LINE.length }] },
			] satisfies TestMessage[]);

			// The helpers' toolResults shape does not carry `text`; inject the leak
			// into the raw tool_results JSON the way a real transcript would.
			const toolResultId = ids[1]!;
			await db.prepare("UPDATE messages SET tool_results = ? WHERE id = ?").run(
				JSON.stringify([{ toolName: "bash", isError: false, textLength: TOOL_RESULT_LINE.length, text: TOOL_RESULT_LINE }]),
				toolResultId,
			);

			const summary = await (await newFramework(db)).run("ds-4", { analyzerIds: ["detect-secrets"] });
			assert.equal(summary.errors.length, 0);
			const { props } = await readNode(db);
			assert.ok(props.leak_count >= 1);
			const finding = props.leaks.find((l) => l.rule_id === "keyword-assignment")!;
			assert.ok(finding, "the keyword generator should flag the tool result");
			assert.equal(finding.field, "tool_results");
			assert.equal(finding.message_id, toolResultId);
			// The fingerprint covers exactly the candidate value.
			const { fingerprintOf } = await import("../../src/analyze/analyzers/detect-secrets/detectors.js");
			assert.equal(finding.fingerprint, fingerprintOf(RANDOM_B64_ALT));
			assert.ok(!JSON.stringify(props).includes(RANDOM_B64_ALT.slice(10, -10)));
		} finally {
			await close();
		}
	});

	it("applies exclusion filters in the live pipeline (placeholders produce no findings)", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "ds-5");
			await insertMessages(db, "ds-5", [
				{ role: "user", text: `password = "YOUR_API_KEY_HERE"` },
				{ role: "user", text: `see https://example.com/?token=${RANDOM_B64} for docs` },
				{ role: "user", text: `secret = get_secret_key()` },
			] satisfies TestMessage[]);

			const summary = await (await newFramework(db)).run("ds-5", { analyzerIds: ["detect-secrets"] });
			assert.equal(summary.errors.length, 0);
			const { props } = await readNode(db);
			assert.equal(props.has_leaks, false);
			assert.equal(props.leak_count, 0);
			assert.ok(props.filtered_matches > 0, "filters should have recorded rejections");
			assert.ok(Object.keys(props.filter_counts).length > 0);
			// Anchors only to the session (no leaked messages).
			const row = (await db
				.prepare("SELECT id FROM analysis_nodes WHERE analyzer_id = ?")
				.get(DETECT_SECRETS_DEF.id)) as { id: string };
			const edges = await db
				.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ? AND edge_kind = 'anchors'")
				.all(row.id) as Array<Record<string, unknown>>;
			assert.equal(edges.length, 1);
			assert.equal(edges[0]!["to_ref_kind"], "session");
		} finally {
			await close();
		}
	});

	it("clean session produces a node with has_leaks=false", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "ds-6");
			await insertMessages(db, "ds-6", [
				{ role: "user", text: "refactor the helpers please" },
				{ role: "assistant", text: "splitting them by concern" },
			] satisfies TestMessage[]);

			const summary = await (await newFramework(db)).run("ds-6", { analyzerIds: ["detect-secrets"] });
			assert.equal(summary.errors.length, 0);
			assert.equal(summary.nodesProduced, 1);
			const { props } = await readNode(db);
			assert.equal(props.has_leaks, false);
			assert.equal(props.leak_count, 0);
			assert.equal(props.filtered_matches, 0);
		} finally {
			await close();
		}
	});
});
