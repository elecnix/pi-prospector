/**
 * Component tests for the DataProfiler-method tabular file PII detector
 * analyzer, exercised end-to-end through the real AnalyzerFramework. Real
 * SQLite (temp file), no network, no LLM — detection is deterministic.
 *
 * These prove the analyzer plans, pairs file reads/writes with their captured
 * content through the shared action stream (by tool-call id), profiles the
 * captured tables (header labels + value distributions), persists one metric
 * node anchored to the session and the touching messages, is idempotent on
 * re-run, honours config overrides (format toggles → stale/config revise,
 * fingerprint allowlists), and never writes file content or a full PII value
 * into the analysis graph.
 *
 * All fixture values are synthetic: example.com addresses, the public Luhn
 * test card, RFC 5737 TEST-NET addresses, 555-01xx fictional numbers.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AsyncDatabase } from "../src/db/async-db.js";
import { tempDb, insertSession, insertMessages, type TestMessage } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import {
	DATAPROFILER_DEF,
	dataprofilerAnalyzer,
	type DataprofilerProperties,
} from "../../src/analyze/analyzers/dataprofiler/index.js";
import { fingerprintOf } from "../../src/analyze/analyzers/secret-scanner.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";

const CUSTOMERS_CSV = [
	"name,email,phone",
	"Ada Lovelace,ada@example.com,+1 415 555 0132",
	"Grace Hopper,grace@example.com,+1 415 555 0133",
	"Alan Turing,alan@example.com,+1 415 555 0134",
].join("\n");

const ORDERS_TSV = [
	"order_id\tcontact_email\tcard",
	"1001\tada@example.com\t4111 1111 1111 1111",
	"1002\tgrace@example.com\t5500 0000 0000 0004",
	"1003\talan@example.com\t4242 4242 4242 4242",
].join("\n");

/** Framework with the dataprofiler analyzer registered. */
async function newFramework(
	db: AsyncDatabase,
	configOverrides?: Record<string, Record<string, unknown>>,
) {
	const fw = new AnalyzerFramework({
		db,
		// Unused by this analyzer (deterministic) but required by the framework ctor.
		llm: createMockLLM({ fallback: "" }).caller,
		modelTiers: DEFAULT_MODEL_TIERS,
		configOverrides,
	});
	await fw.register(dataprofilerAnalyzer);
	return fw;
}

async function readNodes(db: AsyncDatabase): Promise<Array<Record<string, unknown>>>  {
	return await db
		.prepare("SELECT * FROM analysis_nodes WHERE analyzer_id = ? ORDER BY created_at ASC")
		.all(DATAPROFILER_DEF.id) as Array<Record<string, unknown>>;
}

async function newestProps(db: AsyncDatabase): DataprofilerProperties  {
	const rows = await readNodes(db);
	assert.ok(rows.length >= 1, "dataprofiler analyzer should produce at least one node");
	const row = rows[rows.length - 1]!; // newest (append-only graph)
	return JSON.parse(row["content_json"] as string) as DataprofilerProperties;
}

describe("dataprofiler component test", () => {
	it("profiles files read and written, anchors correctly, stores no full value", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "dp-1");
			const ids = await insertMessages(db, "dp-1", [
				{ role: "user", text: "Please check the customer export before we ship it." },
				// Assistant reads customers.csv via the structured read tool…
				{ role: "assistant" },
				// …then cats orders.tsv through bash.
				{ role: "assistant" },
				// Ordinary prose: no touches, no findings.
				{ role: "assistant", text: "Both files reviewed; nothing else to report." },
			] satisfies TestMessage[]);

			const readCallMsg = ids[1]!;
			const bashCallMsg = ids[2]!;
			const readResultMsg = `${readCallMsg}-r`;
			const bashResultMsg = `${bashCallMsg}-r`;

			// Write the exact stored shapes directly: tool calls with provider ids
			// on the assistant rows, paired result envelopes with captured content
			// on inserted toolResult rows.
			await db.prepare("UPDATE messages SET tool_calls = ? WHERE id = ?").run(
				JSON.stringify([{ id: "call-read-1", name: "read", arguments: { file_path: "/data/customers.csv" } }]),
				readCallMsg,
			);
			await db.prepare("UPDATE messages SET tool_calls = ? WHERE id = ?").run(
				JSON.stringify([{ id: "call-cat-1", name: "bash", arguments: { command: "cat /data/orders.tsv" } }]),
				bashCallMsg,
			);
			const insertResult = await db.prepare(
				"INSERT INTO messages (id, session_id, source, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, model, cost_usd) " +
					"VALUES (?, ?, 'pi', ?, ?, 'toolResult', ?, NULL, NULL, ?, NULL, NULL)",
			);
			insertResult.run(
				readResultMsg,
				"dp-1",
				readCallMsg,
				new Date().toISOString(),
				CUSTOMERS_CSV,
				JSON.stringify([{ toolCallId: "call-read-1", toolName: "read", isError: false, textLength: CUSTOMERS_CSV.length }]),
			);
			insertResult.run(
				bashResultMsg,
				"dp-1",
				bashCallMsg,
				new Date().toISOString(),
				ORDERS_TSV,
				JSON.stringify([{ toolCallId: "call-cat-1", toolName: "bash", isError: false, textLength: ORDERS_TSV.length }]),
			);

			const fw = await newFramework(db);
			const first = await fw.run("dp-1", { analyzerIds: ["dataprofiler"] });
			assert.equal(first.nodesProduced, 1);
			assert.equal(first.errors.length, 0);

			const row = (await readNodes(db)).at(-1)!;
			assert.equal(row["node_kind"], "metric");
			const props = JSON.parse(row["content_json"] as string) as DataprofilerProperties;

			assert.equal(props.has_findings, true);
			assert.equal(props.finding_count, 2); // customers.csv + orders.tsv
			assert.equal(props.files_touched, 2);
			assert.equal(props.files_profiled, 2);
			assert.deepEqual(props.format_counts, { csv: 1, tsv: 1, json: 0 });

			const byPath = new Map(props.findings.map((f) => [f.path, f]));
			const customers = byPath.get("/data/customers.csv")!;
			assert.ok(customers);
			assert.equal(customers.direction, "read");
			assert.equal(customers.tool, "read");
			assert.equal(customers.message_id, readCallMsg);
			assert.equal(customers.result_message_id, readResultMsg);
			assert.equal(customers.severity, "high");
			const custCols = new Map(customers.sensitive_columns.map((c) => [c.column_name, c]));
			assert.deepEqual([...custCols.keys()].sort(), ["email", "name", "phone"]);
			assert.equal(custCols.get("email")!.verdict, "confirmed");
			assert.equal(custCols.get("name")!.verdict, "label-only");
			assert.equal(custCols.get("email")!.fingerprint, fingerprintOf("ada@example.com"));

			const orders = byPath.get("/data/orders.tsv")!;
			assert.ok(orders);
			assert.equal(orders.tool, "bash");
			const orderCols = new Map(orders.sensitive_columns.map((c) => [c.column_name, c]));
			assert.deepEqual([...orderCols.keys()].sort(), ["card", "contact_email"]);
			assert.equal(orderCols.get("card")!.verdict, "confirmed");

			// No full PII value or file content may appear anywhere in the
			// persisted node content.
			const contentJson = row["content_json"] as string;
			for (const value of [
				"ada@example.com",
				"grace@example.com",
				"Ada Lovelace",
				"+1 415 555 0132",
				"4111 1111 1111 1111",
				"name,email,phone",
			]) {
				assert.ok(!contentJson.includes(value), `full value must not be persisted: ${value}`);
			}

			// Anchors: one to the session, one per message whose tool call produced
			// a finding — here the two distinct assistant call messages.
			const edges = await db
				.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ?")
				.all(row["id"]) as Array<Record<string, unknown>>;
			const anchors = edges.filter((e) => e["edge_kind"] === "anchors");
			const targets = anchors.map((e) => `${e["to_ref_kind"]}:${e["to_ref_id"]}`).sort();
			assert.deepEqual(targets, [`message:${ids[1]}`, `message:${ids[2]}`, "session:dp-1"]);
		} finally {
			await close();
		}
	});

	it("is idempotent: a second run produces no new node", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "dp-2");
			const ids = await insertMessages(db, "dp-2", [
				{ role: "assistant" },
			] satisfies TestMessage[]);
			await db.prepare("UPDATE messages SET tool_calls = ? WHERE id = ?").run(
				JSON.stringify([{ id: "call-r", name: "read", arguments: { file_path: "/data/customers.csv" } }]),
				ids[0]!,
			);
			await db.prepare(
				"INSERT INTO messages (id, session_id, source, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, model, cost_usd) " +
					"VALUES (?, ?, 'pi', ?, ?, 'toolResult', ?, NULL, NULL, ?, NULL, NULL)",
			).run(
				`${ids[0]}-r`,
				"dp-2",
				ids[0],
				new Date().toISOString(),
				CUSTOMERS_CSV,
				JSON.stringify([{ toolCallId: "call-r", toolName: "read", isError: false, textLength: CUSTOMERS_CSV.length }]),
			);

			const fw = await newFramework(db);
			const first = await fw.run("dp-2", { analyzerIds: ["dataprofiler"] });
			assert.equal(first.nodesProduced, 1);
			const second = await fw.run("dp-2", { analyzerIds: ["dataprofiler"] });
			assert.equal(second.nodesProduced, 0);
			assert.equal(second.nodesSkipped, 1);

			const count = ((await db
				.prepare("SELECT COUNT(*) as c FROM analysis_nodes WHERE analyzer_id = ?")
				.get(DATAPROFILER_DEF.id)) as { c: number }).c;
			assert.equal(count, 1);
		} finally {
			await close();
		}
	});

	it("config overrides apply: format toggle marks stale and revises; allowlist silences", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "dp-3");
			const ids = await insertMessages(db, "dp-3", [
				{ role: "assistant" },
			] satisfies TestMessage[]);
			await db.prepare("UPDATE messages SET tool_calls = ? WHERE id = ?").run(
				JSON.stringify([{ id: "call-r", name: "read", arguments: { file_path: "/data/customers.csv" } }]),
				ids[0]!,
			);
			await db.prepare(
				"INSERT INTO messages (id, session_id, source, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, model, cost_usd) " +
					"VALUES (?, ?, 'pi', ?, ?, 'toolResult', ?, NULL, NULL, ?, NULL, NULL)",
			).run(
				`${ids[0]}-r`,
				"dp-3",
				ids[0],
				new Date().toISOString(),
				CUSTOMERS_CSV,
				JSON.stringify([{ toolCallId: "call-r", toolName: "read", isError: false, textLength: CUSTOMERS_CSV.length }]),
			);

			// Baseline: three sensitive columns (email + phone confirmed, name label-only).
			const fw1 = await newFramework(db);
			await fw1.run("dp-3", { analyzerIds: ["dataprofiler"] });
			const baseline = await newestProps(db);
			assert.equal(baseline.finding_count, 1);
			assert.equal(baseline.sensitive_columns, 3);

			// Disable the csv format: config change → stale/config → revise; the
			// file is no longer extracted at all.
			const fw2 = await newFramework(db, {
				dataprofiler: { formats: { csv: false, tsv: true, json: true } },
			});
			await fw2.run("dp-3", { analyzerIds: ["dataprofiler"], revise: ["config"] });
			const revised = await newestProps(db);
			assert.equal(revised.finding_count, 0);
			assert.equal(revised.has_findings, false);
			assert.equal(revised.files_touched, 0);

			// Re-enable csv but allowlist every matched value by fingerprint: the
			// email and phone columns lose all value support and downgrade to
			// label-only — the header alone keeps them visible at low severity.
			const fw3 = await newFramework(db, {
				dataprofiler: {
					formats: { csv: true, tsv: true, json: true },
					allowFingerprints: [
						fingerprintOf("ada@example.com"),
						fingerprintOf("grace@example.com"),
						fingerprintOf("alan@example.com"),
						fingerprintOf("+1 415 555 0132"),
						fingerprintOf("+1 415 555 0133"),
						fingerprintOf("+1 415 555 0134"),
					],
				},
			});
			await fw3.run("dp-3", { analyzerIds: ["dataprofiler"], revise: ["config"] });
			const final = await newestProps(db);
			assert.equal(final.finding_count, 1);
			assert.equal(final.allowlisted_values, 6);
			const cols = new Map(final.findings[0]!.sensitive_columns.map((c) => [c.column_name, c]));
			assert.deepEqual([...cols.keys()].sort(), ["email", "name", "phone"]);
			for (const col of cols.values()) {
				assert.equal(col.verdict, "label-only", col.column_name);
				assert.equal(col.match_count, 0, col.column_name);
			}
		} finally {
			await close();
		}
	});
});
