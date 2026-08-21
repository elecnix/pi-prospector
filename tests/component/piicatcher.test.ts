/**
 * Component tests for the PIICatcher-method column-semantics PII detector
 * analyzer, exercised end-to-end through the real AnalyzerFramework. Real
 * SQLite (temp file), no network, no LLM — detection is deterministic.
 *
 * These prove the analyzer plans, detects tabular fragments across message
 * fields (CSV in tool results, JSON records in prose), classifies columns by
 * sampling, persists a metric node anchored to the session and the affected
 * messages, is idempotent on re-run, honours config overrides (format
 * toggles → stale/config revise), and never writes a full PII value into the
 * analysis graph.
 *
 * All fixture values are synthetic: example.com addresses, the public Luhn
 * test card, RFC 5737 TEST-NET addresses, 555-01xx fictional numbers.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages, type TestMessage } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import {
	PIICATCHER_DEF,
	piicatcherAnalyzer,
	type PiicatcherProperties,
} from "../../src/analyze/analyzers/piicatcher/index.js";
import { fingerprintOf } from "../../src/analyze/analyzers/secret-scanner.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";

const CSV_BLOCK = [
	"name,email,card",
	"Ada Lovelace,ada@example.com,4111 1111 1111 1111",
	"Grace Hopper,grace@example.com,5500 0000 0000 0004",
	"Alan Turing,alan@example.com,4242 4242 4242 4242",
].join("\n");

const JSON_BLOCK = [
	"Here is the customer export:",
	'[{"user": "ada", "ip": "203.0.113.5"},',
	' {"user": "grace", "ip": "203.0.113.6"},',
	' {"user": "alan", "ip": "203.0.113.7"}]',
	"End of export.",
].join("\n");

/** Framework with the piicatcher analyzer registered. */
function newFramework(
	db: import("better-sqlite3").Database,
	configOverrides?: Record<string, Record<string, unknown>>,
) {
	const fw = new AnalyzerFramework({
		db,
		// Unused by this analyzer (deterministic) but required by the framework ctor.
		llm: createMockLLM({ fallback: "" }).caller,
		modelTiers: DEFAULT_MODEL_TIERS,
		configOverrides,
	});
	fw.register(piicatcherAnalyzer);
	return fw;
}

function readNodes(db: import("better-sqlite3").Database): Array<Record<string, unknown>> {
	return db
		.prepare("SELECT * FROM analysis_nodes WHERE analyzer_id = ? ORDER BY created_at ASC")
		.all(PIICATCHER_DEF.id) as Array<Record<string, unknown>>;
}

function newestProps(db: import("better-sqlite3").Database): PiicatcherProperties {
	const rows = readNodes(db);
	assert.ok(rows.length >= 1, "piicatcher analyzer should produce at least one node");
	const row = rows[rows.length - 1]!; // newest (append-only graph)
	return JSON.parse(row["content_json"] as string) as PiicatcherProperties;
}

describe("piicatcher component test", () => {
	it("detects column findings across fields, anchors correctly, stores no full value", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "piic-1");
			const ids = insertMessages(db, "piic-1", [
				// CSV block surfaced through a read tool's result.
				{ role: "user", toolResults: [{ toolName: "db-query", isError: false, textLength: CSV_BLOCK.length }] },
				// JSON records pasted into user prose.
				{ role: "user", text: JSON_BLOCK },
				// Ordinary prose: no fragments, no findings.
				{ role: "assistant", text: "The export has been reviewed; nothing else to report." },
			] satisfies TestMessage[]);
			// The helper serialises toolResults as a JSON envelope; write the raw
			// CSV block directly into the tool_results field for message 0.
			db.prepare("UPDATE messages SET tool_results = ? WHERE id = ?").run(CSV_BLOCK, ids[0]!);

			const fw = newFramework(db);
			const first = await fw.run("piic-1", { analyzerIds: ["piicatcher"] });
			assert.equal(first.nodesProduced, 1);
			assert.equal(first.errors.length, 0);

			const row = readNodes(db).at(-1)!;
			assert.equal(row["node_kind"], "metric");
			const props = JSON.parse(row["content_json"] as string) as PiicatcherProperties;

			assert.equal(props.has_findings, true);
			assert.equal(props.message_count, 3);
			// CSV: email + card columns sensitive (name is not); JSON: ip column.
			assert.equal(props.finding_count, 3);
			assert.ok(props.fragments_scanned >= 2);
			assert.deepEqual(props.format_counts["csv"] >= 1, true);
			assert.deepEqual(props.format_counts["json"] >= 1, true);

			const csvFindings = props.findings.filter((f) => f.fragment_kind === "csv");
			assert.deepEqual(
				csvFindings.map((f) => f.column_name).sort(),
				["card", "email"],
			);
			const email = csvFindings.find((f) => f.column_name === "email")!;
			assert.equal(email.field, "tool_results");
			assert.equal(email.sample_size, 3);
			assert.equal(email.match_count, 3);
			assert.equal(email.match_ratio, 1);
			assert.deepEqual(Object.keys(email.entity_types), ["EMAIL_ADDRESS"]);
			assert.equal(email.fingerprint, fingerprintOf("ada@example.com"));
			assert.ok(!email.redacted_preview.includes("ada@example.com"));

			const jsonFinding = props.findings.find((f) => f.fragment_kind === "json")!;
			assert.equal(jsonFinding.column_name, "ip");
			assert.deepEqual(Object.keys(jsonFinding.entity_types), ["IP_ADDRESS"]);
			assert.equal(jsonFinding.fingerprint, fingerprintOf("203.0.113.5"));

			// No full PII value may appear anywhere in the persisted node content.
			const contentJson = row["content_json"] as string;
			for (const value of [
				"ada@example.com",
				"grace@example.com",
				"alan@example.com",
				"4111 1111 1111 1111",
				"4111111111111111",
				"203.0.113.5",
			]) {
				assert.ok(!contentJson.includes(value), `full value must not be persisted: ${value}`);
			}

			// Anchors: one to the session, one per message with a finding.
			const edges = db
				.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ?")
				.all(row["id"]) as Array<Record<string, unknown>>;
			const anchors = edges.filter((e) => e["edge_kind"] === "anchors");
			assert.equal(anchors.length, 3);
			const targets = anchors.map((e) => `${e["to_ref_kind"]}:${e["to_ref_id"]}`).sort();
			assert.deepEqual(targets, [`message:${ids[0]}`, `message:${ids[1]}`, "session:piic-1"]);
		} finally {
			close();
		}
	});

	it("is idempotent: a second run produces no new node", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "piic-2");
			const ids = insertMessages(db, "piic-2", [
				{ role: "user", toolResults: [{ toolName: "db-query", isError: false, textLength: CSV_BLOCK.length }] },
			] satisfies TestMessage[]);
			db.prepare("UPDATE messages SET tool_results = ? WHERE id = ?").run(CSV_BLOCK, ids[0]!);

			const fw = newFramework(db);
			const first = await fw.run("piic-2", { analyzerIds: ["piicatcher"] });
			assert.equal(first.nodesProduced, 1);
			const second = await fw.run("piic-2", { analyzerIds: ["piicatcher"] });
			assert.equal(second.nodesProduced, 0);
			assert.equal(second.nodesSkipped, 1);

			const count = (db
				.prepare("SELECT COUNT(*) as c FROM analysis_nodes WHERE analyzer_id = ?")
				.get(PIICATCHER_DEF.id) as { c: number }).c;
			assert.equal(count, 1);
		} finally {
			close();
		}
	});

	it("config overrides apply: format toggle marks stale and revises", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "piic-3");
			const ids = insertMessages(db, "piic-3", [
				{ role: "user", toolResults: [{ toolName: "db-query", isError: false, textLength: CSV_BLOCK.length }] },
				{ role: "user", text: JSON_BLOCK },
			] satisfies TestMessage[]);
			db.prepare("UPDATE messages SET tool_results = ? WHERE id = ?").run(CSV_BLOCK, ids[0]!);

			// Baseline: three findings (csv email+card, json ip).
			const fw1 = newFramework(db);
			await fw1.run("piic-3", { analyzerIds: ["piicatcher"] });
			assert.equal(newestProps(db).finding_count, 3);

			// Disable the csv format: config change → stale/config → revise; only
			// the JSON ip finding survives.
			const fw2 = newFramework(db, {
				piicatcher: { formats: { csv: false, json: true, sql: true } },
			});
			await fw2.run("piic-3", { analyzerIds: ["piicatcher"], revise: ["config"] });
			const revised = newestProps(db);
			assert.equal(revised.finding_count, 1);
			assert.equal(revised.findings[0]!.fragment_kind, "json");

			// Allowlist the TEST-NET addresses by fingerprint: the ip column no
			// longer matches, so no finding remains.
			const fw3 = newFramework(db, {
				piicatcher: {
					formats: { csv: false, json: true, sql: true },
					allowFingerprints: [fingerprintOf("203.0.113.5"), fingerprintOf("203.0.113.6"), fingerprintOf("203.0.113.7")],
				},
			});
			await fw3.run("piic-3", { analyzerIds: ["piicatcher"], revise: ["config"] });
			const final = newestProps(db);
			assert.equal(final.finding_count, 0);
			assert.equal(final.has_findings, false);
			assert.ok(final.allowlisted_values >= 3);
		} finally {
			close();
		}
	});
});
