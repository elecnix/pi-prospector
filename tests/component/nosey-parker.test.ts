/**
 * Component tests for the nosey-parker analyzer, exercised end-to-end through
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
import {
	noseyParkerAnalyzer,
	NOSEY_PARKER_DEF,
	type NoseyParkerProperties,
} from "../../src/analyze/analyzers/nosey-parker/index.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";

// Shape-correct, never-live synthetic credentials, built by concatenation so
// no contiguous realistic literal exists in source.
const GROQ_KEY = "gsk_" + "a".repeat(50);
// Unquoted: inside a tool_result the text is JSON-encoded, so quotes would be
// escaped (`\"`) and fall outside the WireGuard assignment pattern.
const WIREGUARD_LINE = `PrivateKey = ${"a".repeat(43)}=`;

function newFramework(db: import("better-sqlite3").Database) {
	const fw = new AnalyzerFramework({
		db,
		// Unused by this analyzer (deterministic) but required by the framework ctor.
		llm: createMockLLM({ fallback: "" }).caller,
		modelTiers: DEFAULT_MODEL_TIERS,
	});
	fw.register(noseyParkerAnalyzer);
	return fw;
}

function readNode(
	db: import("better-sqlite3").Database,
): { row: Record<string, unknown>; props: NoseyParkerProperties } {
	const rows = db
		.prepare("SELECT * FROM analysis_nodes WHERE analyzer_id = ? ORDER BY created_at ASC")
		.all(NOSEY_PARKER_DEF.id) as Array<Record<string, unknown>>;
	assert.ok(rows.length >= 1, "nosey-parker analyzer should produce at least one node");
	const row = rows[rows.length - 1]!; // newest (append-only graph)
	const props = JSON.parse(row["content_json"] as string) as NoseyParkerProperties;
	return { row, props };
}

describe("nosey-parker component test", () => {
	it("detects a secret in a user message, anchors to session and message, and stores no full secret", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "np-1");
			const ids = insertMessages(db, "np-1", [
				{ role: "user", text: `here is my key: ${GROQ_KEY}` },
				{ role: "assistant", text: "got it" },
			] satisfies TestMessage[]);

			const fw = newFramework(db);
			const first = await fw.run("np-1", { analyzerIds: ["nosey-parker"] });
			assert.equal(first.nodesProduced, 1);
			const { row, props } = readNode(db);
			assert.equal(row["node_kind"], "metric");
			assert.equal(first.errors.length, 0);
			assert.equal(props.has_leaks, true);
			assert.equal(props.leak_count, 1);
			assert.equal(props.leaks[0]!.rule_id, "groq-api-key");
			assert.equal(props.leaks[0]!.confidence, "passive");
			assert.equal(props.leaks[0]!.message_id, ids[0]);

			// The full secret must not be anywhere in the persisted node content.
			const contentJson = row["content_json"] as string;
			assert.ok(!contentJson.includes(GROQ_KEY), "full secret must not be persisted");
			assert.ok(!contentJson.includes(GROQ_KEY.slice(4, -4)), "middle of secret must not be persisted");

			// Anchors: one to the session, one to the leaked message.
			const edges = db
				.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ?")
				.all(row["id"]) as Array<Record<string, unknown>>;
			const anchors = edges.filter((e) => e["edge_kind"] === "anchors");
			assert.equal(anchors.length, 2);
			const targets = anchors.map((e) => `${e["to_ref_kind"]}:${e["to_ref_id"]}`).sort();
			assert.deepEqual(targets, [`message:${ids[0]}`, "session:np-1"]);
		} finally {
			close();
		}
	});

	it("is idempotent: a second run produces no new node", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "np-2");
			insertMessages(db, "np-2", [
				{ role: "user", text: `key ${GROQ_KEY}` },
			] satisfies TestMessage[]);

			const fw = newFramework(db);
			const first = await fw.run("np-2", { analyzerIds: ["nosey-parker"] });
			assert.equal(first.nodesProduced, 1);
			const second = await fw.run("np-2", { analyzerIds: ["nosey-parker"] });
			assert.equal(second.nodesProduced, 0);
			assert.equal(second.nodesSkipped, 1);

			// Still exactly one node.
			const count = (db
				.prepare("SELECT COUNT(*) as c FROM analysis_nodes WHERE analyzer_id = ?")
				.get(NOSEY_PARKER_DEF.id) as { c: number }).c;
			assert.equal(count, 1);
		} finally {
			close();
		}
	});

	it("re-identifies when the session grows new turns and rescans", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "np-3");
			insertMessages(db, "np-3", [
				{ role: "user", text: "hello" },
				{ role: "assistant", text: "hi" },
			] satisfies TestMessage[]);

			const fw = newFramework(db);
			const first = await fw.run("np-3", { analyzerIds: ["nosey-parker"] });
			assert.equal(first.nodesProduced, 1);
			// Clean first run.
			{
				const { props } = readNode(db);
				assert.equal(props.leak_count, 0);
			}

			// Append a turn that introduces a secret.
			insertMessages(db, "np-3", [
				{ role: "user", text: WIREGUARD_LINE },
			] satisfies TestMessage[]);
			const second = await fw.run("np-3", { analyzerIds: ["nosey-parker"] });
			assert.equal(second.nodesProduced, 1, "growing the session should re-trigger the analyzer");

			// Append-only: the clean first node remains; the newest node carries the leak.
			const nodeCount = (db
				.prepare("SELECT COUNT(*) as c FROM analysis_nodes WHERE analyzer_id = ?")
				.get(NOSEY_PARKER_DEF.id) as { c: number }).c;
			assert.equal(nodeCount, 2, "a re-identified unit adds a node, leaving the old one as lineage");

			const { props } = readNode(db);
			assert.equal(props.leak_count, 1);
			assert.equal(props.leaks[0]!.rule_id, "wireguard-private-key");
			assert.equal(props.leaks[0]!.confidence, "active");
		} finally {
			close();
		}
	});

	it("detects a captured secret inside a tool_result field", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "np-4");
			const ids = insertMessages(db, "np-4", [
				{ role: "user", text: "show me the wireguard config" },
				{ role: "toolResult", toolResults: [{ toolName: "read", isError: false, textLength: WIREGUARD_LINE.length }] },
			] satisfies TestMessage[]);

			// The helpers' toolResults shape does not carry `text`; inject the leak
			// into the raw tool_results JSON the way a real transcript would.
			const toolResultId = ids[1]!;
			db.prepare("UPDATE messages SET tool_results = ? WHERE id = ?").run(
				JSON.stringify([{ toolName: "read", isError: false, textLength: WIREGUARD_LINE.length, text: WIREGUARD_LINE }]),
				toolResultId,
			);

			const summary = await newFramework(db).run("np-4", { analyzerIds: ["nosey-parker"] });
			assert.equal(summary.errors.length, 0);
			const { props } = readNode(db);
			assert.equal(props.leak_count, 1);
			assert.equal(props.leaks[0]!.rule_id, "wireguard-private-key");
			assert.equal(props.leaks[0]!.field, "tool_results");
			assert.equal(props.leaks[0]!.message_id, toolResultId);
			// The fingerprint covers exactly the captured key material.
			const { fingerprintOf } = await import("../../src/analyze/analyzers/nosey-parker/detectors.js");
			assert.equal(props.leaks[0]!.fingerprint, fingerprintOf("a".repeat(43) + "="));
			assert.ok(!JSON.stringify(props).includes(WIREGUARD_LINE.slice(10, -10)));
		} finally {
			close();
		}
	});

	it("clean session produces a node with has_leaks=false", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "np-5");
			insertMessages(db, "np-5", [
				{ role: "user", text: "refactor the helpers please" },
				{ role: "assistant", text: "splitting them by concern" },
			] satisfies TestMessage[]);

			const summary = await newFramework(db).run("np-5", { analyzerIds: ["nosey-parker"] });
			assert.equal(summary.errors.length, 0);
			assert.equal(summary.nodesProduced, 1);
			const { props } = readNode(db);
			assert.equal(props.has_leaks, false);
			assert.equal(props.leak_count, 0);
			// Anchors only to the session (no leaked messages).
			const row = db
				.prepare("SELECT id FROM analysis_nodes WHERE analyzer_id = ?")
				.get(NOSEY_PARKER_DEF.id) as { id: string };
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
