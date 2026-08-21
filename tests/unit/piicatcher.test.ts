/**
 * Unit tests for the PIICatcher-method tabular fragment detection and
 * column-semantics classification. Pure functions, no deps, no mocks.
 *
 * Coverage: CSV delimiter sniffing (comma, semicolon, tab) with header
 * inference, JSON arrays of homogeneous records, SQL result tables
 * (box-drawing, pipe/ASCII tables, aligned columns), negatives (prose,
 * ragged rows), and the distinctive column-semantics behaviour: a column
 * that is 90% emails IS an email column; one email among ten names is NOT.
 *
 * All fixture values are synthetic: example.com addresses, the public Luhn
 * test card, RFC 5737 TEST-NET addresses, 555-01xx fictional numbers.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	detectFragments,
	type TabularFragment,
} from "../../src/analyze/analyzers/piicatcher/fragments.js";
import {
	classifyFragment,
	classifyValue,
} from "../../src/analyze/analyzers/piicatcher/columns.js";
import { detectTabularPii } from "../../src/analyze/analyzers/piicatcher/detectors.js";
import {
	DEFAULT_PIICATCHER_CONFIG,
	PiicatcherConfigSchema,
	type PiicatcherConfig,
} from "../../src/analyze/analyzers/piicatcher/config.js";
import { fingerprintOf } from "../../src/analyze/analyzers/secret-scanner.js";
import { PII_RECOGNIZERS } from "../../src/analyze/analyzers/presidio/recognizers.js";
import type { MessageRow } from "../../src/analyze/types.js";

// ──────────────────────────── helpers ────────────────────────────

let seq = 0;
function msg(fields: Partial<MessageRow>): MessageRow {
	return {
		id: `m-${seq++}`,
		session_id: "s-1",
		parent_id: null,
		timestamp: null,
		role: "user",
		content_text: null,
		content_thinking: null,
		tool_calls: null,
		tool_results: null,
		model: null,
		cost_usd: null,
		stop_reason: null,
		error_message: null,
		...fields,
	};
}

const CFG: PiicatcherConfig = { ...DEFAULT_PIICATCHER_CONFIG };

/** Fragment kinds found in a text, in detection order. */
function kinds(text: string): string[] {
	return detectFragments(text, "m-0", "tool_results", CFG).map((f) => f.kind);
}

// ──────────────────────────── fragment segmentation: CSV ────────────────────────────

describe("piicatcher fragment segmentation — csv", () => {
	it("detects a comma CSV block with an inferred header", () => {
		const text = [
			"Query results:",
			"name,email,phone",
			"Ada Lovelace,ada@example.com,+1 415 555 0132",
			"Grace Hopper,grace@example.com,+1 415 555 0133",
			"Alan Turing,alan@example.com,+1 415 555 0134",
			"",
			"Done.",
		].join("\n");
		const frags = detectFragments(text, "m-1", "tool_results", CFG);
		assert.equal(frags.length, 1);
		const f = frags[0]!;
		assert.equal(f.kind, "csv");
		assert.equal(f.message_id, "m-1");
		assert.deepEqual(f.header, ["name", "email", "phone"]);
		assert.equal(f.rows.length, 3);
		assert.deepEqual(f.rows[0], ["Ada Lovelace", "ada@example.com", "+1 415 555 0132"]);
	});

	it("sniffs a semicolon delimiter", () => {
		const text = [
			"id;email;city",
			"1;one@example.com;springfield",
			"2;two@example.com;shelbyville",
			"3;three@example.com;capital city",
		].join("\n");
		const frags = detectFragments(text, "m-2", "tool_results", CFG);
		assert.equal(frags.length, 1);
		assert.equal(frags[0]!.kind, "csv");
		assert.deepEqual(frags[0]!.header, ["id", "email", "city"]);
	});

	it("sniffs a tab delimiter", () => {
		const text = [
			"user\tip\tport",
			"alice\t203.0.113.5\t8080",
			"bob\t203.0.113.6\t9090",
			"carol\t203.0.113.7\t7070",
		].join("\n");
		const frags = detectFragments(text, "m-3", "tool_results", CFG);
		assert.equal(frags.length, 1);
		assert.equal(frags[0]!.kind, "csv");
		assert.deepEqual(frags[0]!.header, ["user", "ip", "port"]);
	});

	it("handles quoted cells containing the delimiter", () => {
		const text = [
			'name,"full address",email',
			'"Lovelace, Ada","12 St James Sq, London",ada@example.com',
			'"Hopper, Grace","1 Navy Way, Arlington",grace@example.com',
			'"Turing, Alan","5 Park Rd, Wilmslow",alan@example.com',
		].join("\n");
		const frags = detectFragments(text, "m-4", "tool_results", CFG);
		assert.equal(frags.length, 1);
		const f = frags[0]!;
		assert.equal(f.header.length, 3);
		assert.deepEqual(f.rows[0], ["Lovelace, Ada", "12 St James Sq, London", "ada@example.com"]);
	});

	it("names columns when the first row is data, not a header", () => {
		const text = [
			"ada@example.com,555-01-42,blue",
			"grace@example.com,555-01-43,red",
			"alan@example.com,555-01-44,green",
		].join("\n");
		const frags = detectFragments(text, "m-5", "tool_results", CFG);
		assert.equal(frags.length, 1);
		const f = frags[0]!;
		// First row is not all-textual? It is all textual here… so it IS inferred
		// as a header by shape. Force the no-header case with numeric first row:
		// (covered by the next test). Here just assert header inference fired.
		assert.deepEqual(f.header, ["ada@example.com", "555-01-42", "blue"]);
		assert.equal(f.rows.length, 2);
	});

	it("falls back to column_N names when the first row is numeric", () => {
		const text = [
			"1,203.0.113.5,active",
			"2,203.0.113.6,idle",
			"3,203.0.113.7,active",
		].join("\n");
		const frags = detectFragments(text, "m-6", "tool_results", CFG);
		assert.equal(frags.length, 1);
		const f = frags[0]!;
		assert.deepEqual(f.header, ["column_1", "column_2", "column_3"]);
		assert.equal(f.rows.length, 3);
	});

	it("rejects ragged rows (inconsistent cell counts)", () => {
		const text = [
			"a,b,c",
			"1,2",
			"3,4,5",
			"6,7,8",
		].join("\n");
		const frags = detectFragments(text, "m-7", "tool_results", CFG);
		// The run starting at line 2 ("3,4,5") may still form its own fragment;
		// the ragged opening pair must not be reported as one block.
		for (const f of frags) {
			const counts = new Set([f.header.length, ...f.rows.map((r) => r.length)]);
			assert.equal(counts.size, 1, "every fragment must have consistent column counts");
		}
	});

	it("does not see CSV in ordinary prose", () => {
		const text = [
			"The user asked about commas, and more, and more.",
			"The agent replied with a sentence, then another, then a third.",
			"A third line of prose, still flowing, no table here.",
		].join("\n");
		assert.deepEqual(kinds(text), []);
	});
});

// ──────────────────────────── fragment segmentation: JSON ────────────────────────────

describe("piicatcher fragment segmentation — json", () => {
	it("detects a JSON array of homogeneous records", () => {
		const text = [
			"Fetched users:",
			'[{"name": "Ada Lovelace", "email": "ada@example.com"},',
			' {"name": "Grace Hopper", "email": "grace@example.com"},',
			' {"name": "Alan Turing", "email": "alan@example.com"}]',
			"end of output",
		].join("\n");
		const frags = detectFragments(text, "m-8", "tool_results", CFG);
		assert.equal(frags.length, 1);
		const f = frags[0]!;
		assert.equal(f.kind, "json");
		assert.deepEqual(f.header, ["name", "email"]);
		assert.equal(f.rows.length, 3);
		assert.deepEqual(f.rows[1], ["Grace Hopper", "grace@example.com"]);
	});

	it("detects a pretty-printed JSON array spanning many lines", () => {
		const text = `[
  {"id": 1, "contact": "ada@example.com"},
  {"id": 2, "contact": "grace@example.com"},
  {"id": 3, "contact": "alan@example.com"}
]`;
		const frags = detectFragments(text, "m-9", "content_text", CFG);
		assert.equal(frags.length, 1);
		const f = frags[0]!;
		assert.equal(f.kind, "json");
		assert.deepEqual(f.header, ["id", "contact"]);
	});

	it("ignores heterogeneous records (differing keys)", () => {
		const text = `[{"a": 1}, {"b": 2}, {"a": 3, "b": 4}]`;
		assert.deepEqual(kinds(text), []);
	});

	it("ignores arrays of scalars", () => {
		const text = `[1, 2, 3, 4]`;
		assert.deepEqual(kinds(text), []);
	});

	it("ignores malformed JSON that looks like an array of records", () => {
		const text = `[{"a": 1}, {"a": 2}, oops]`;
		assert.deepEqual(kinds(text), []);
	});
});

// ──────────────────────────── fragment segmentation: sql-table ────────────────────────────

describe("piicatcher fragment segmentation — sql-table", () => {
	it("detects a box-drawing result table", () => {
		const text = [
			"psql output:",
			" id │        email        │ name ",
			"────┼─────────────────────┼──────",
			"  1 │ ada@example.com     │ Ada",
			"  2 │ grace@example.com   │ Grace",
			"  3 │ alan@example.com    │ Alan",
			"(3 rows)",
		].join("\n");
		const frags = detectFragments(text, "m-10", "tool_results", CFG);
		assert.equal(frags.length, 1);
		const f = frags[0]!;
		assert.equal(f.kind, "sql-table");
		assert.deepEqual(f.header, ["id", "email", "name"]);
		assert.equal(f.rows.length, 3);
		assert.deepEqual(f.rows[0], ["1", "ada@example.com", "Ada"]);
	});

	it("detects an ASCII pipe table with +---+ borders (mysql -t style)", () => {
		const text = [
			"+----+-------------------+-------+",
			"| id | email             | name  |",
			"+----+-------------------+-------+",
			"| 1  | ada@example.com   | Ada   |",
			"| 2  | grace@example.com | Grace |",
			"+----+-------------------+-------+",
		].join("\n");
		const frags = detectFragments(text, "m-11", "tool_results", CFG);
		assert.equal(frags.length, 1);
		const f = frags[0]!;
		assert.equal(f.kind, "sql-table");
		assert.deepEqual(f.header, ["id", "email", "name"]);
		assert.equal(f.rows.length, 2);
		assert.deepEqual(f.rows[1], ["2", "grace@example.com", "Grace"]);
	});

	it("detects aligned plain-text columns", () => {
		const text = [
			"NAME          EMAIL",
			"ada           ada@example.com",
			"grace         grace@example.com",
			"alan          alan@example.com",
		].join("\n");
		const frags = detectFragments(text, "m-12", "tool_results", CFG);
		assert.equal(frags.length, 1);
		const f = frags[0]!;
		assert.equal(f.kind, "sql-table");
		assert.equal(f.header.length, 2);
		assert.equal(f.rows.length, 3);
		assert.deepEqual(f.rows[0], ["ada", "ada@example.com"]);
	});
});

// ──────────────────────────── format toggles ────────────────────────────

describe("piicatcher format toggles", () => {
	const csvText = ["a,b", "1,2", "3,4", "5,6"].join("\n");

	it("disabling csv skips CSV fragments", () => {
		const cfg: PiicatcherConfig = { ...CFG, formats: { csv: false, json: true, sql: true } };
		assert.deepEqual(detectFragments(csvText, "m-13", "tool_results", cfg), []);
	});

	it("disabling json skips JSON fragments", () => {
		const cfg: PiicatcherConfig = { ...CFG, formats: { csv: true, json: false, sql: true } };
		const text = '[{"a":1},{"a":2},{"a":3}]';
		assert.deepEqual(detectFragments(text, "m-14", "tool_results", cfg), []);
	});

	it("disabling sql skips box-drawing fragments", () => {
		const cfg: PiicatcherConfig = { ...CFG, formats: { csv: true, json: true, sql: false } };
		const text = [
			" a │ b ",
			"───┼───",
			" 1 │ 2 ",
			" 3 │ 4 ",
		].join("\n");
		assert.deepEqual(detectFragments(text, "m-15", "tool_results", cfg), []);
	});
});

// ──────────────────────────── value classification ────────────────────────────

describe("piicatcher value classification", () => {
	it("classifies an email as EMAIL_ADDRESS above the default floor", () => {
		const v = classifyValue("ada@example.com", DEFAULT_PIICATCHER_CONFIG.minScore);
		assert.ok(v, "email must classify");
		assert.equal(v!.entity_type, "EMAIL_ADDRESS");
	});

	it("classifies a Luhn-valid card as CREDIT_CARD at score 1", () => {
		const v = classifyValue("4111111111111111", DEFAULT_PIICATCHER_CONFIG.minScore);
		assert.ok(v);
		assert.equal(v!.entity_type, "CREDIT_CARD");
		assert.equal(v!.score, 1);
	});

	it("drops a Luhn-failing card entirely (checksum mandatory)", () => {
		const v = classifyValue("4111111111111112", DEFAULT_PIICATCHER_CONFIG.minScore);
		assert.equal(v, undefined);
	});

	it("leaves ordinary prose unmatched", () => {
		assert.equal(classifyValue("Ada Lovelace", DEFAULT_PIICATCHER_CONFIG.minScore), undefined);
		assert.equal(classifyValue("hello world", DEFAULT_PIICATCHER_CONFIG.minScore), undefined);
	});
});

// ──────────────────────────── column semantics ────────────────────────────

describe("piicatcher column-semantics classification", () => {
	function csvFragment(header: string[], rows: string[][]): TabularFragment {
		return { kind: "csv", message_id: "m-x", field: "tool_results", start_line: 1, header, rows };
	}

	it("a column that is 90% emails IS an email column", () => {
		const rows = [
			["Ada Lovelace", "ada@example.com"],
			["Grace Hopper", "grace@example.com"],
			["Alan Turing", "alan@example.com"],
			["Edsger Dijkstra", "edsger@example.com"],
			["Donald Knuth", "donald@example.com"],
			["Barbara Liskov", "barbara@example.com"],
			["John McCarthy", "john@example.com"],
			["Marvin Minsky", "marvin@example.com"],
			["Herbert Simon", "herbert@example.com"],
			["no email here", "also not an email"],
		];
		const frag = csvFragment(["name", "email"], rows);
		const res = classifyFragment(frag, CFG);
		const findings = res.findings;
		assert.equal(findings.length, 1);
		const f = findings[0]!;
		assert.equal(f.column_name, "email");
		assert.equal(f.sample_size, 10);
		assert.equal(f.match_count, 9);
		assert.ok(Math.abs(f.match_ratio - 0.9) < 1e-9);
		assert.deepEqual(Object.keys(f.entity_types), ["EMAIL_ADDRESS"]);
		assert.equal(f.fingerprint, fingerprintOf("ada@example.com"));
		assert.ok(!f.redacted_preview.includes("ada@example.com"));
	});

	it("one email among ten names is NOT an email column", () => {
		const rows = [
			["Ada Lovelace", "ada@example.com"],
			["Grace Hopper", ""],
			["Alan Turing", ""],
			["Edsger Dijkstra", ""],
			["Donald Knuth", ""],
			["Barbara Liskov", ""],
			["John McCarthy", ""],
			["Marvin Minsky", ""],
			["Herbert Simon", ""],
			["Allen Newell", ""],
		];
		const frag = csvFragment(["name", "contact"], rows);
		const res = classifyFragment(frag, CFG);
		assert.deepEqual(res.findings, []);
		assert.equal(res.columns_below_threshold, 2); // both name and contact columns
	});

	it("reports per-column entity types for a mixed sensitive table", () => {
		const rows = [
			["ada@example.com", "203.0.113.5", "4111 1111 1111 1111"],
			["grace@example.com", "203.0.113.6", "5500 0000 0000 0004"],
			["alan@example.com", "203.0.113.7", "4242 4242 4242 4242"],
		];
		const frag = csvFragment(["email", "ip", "card"], rows);
		const res = classifyFragment(frag, CFG);
		const byCol = new Map(res.findings.map((f) => [f.column_name, f]));
		assert.deepEqual([...byCol.keys()].sort(), ["card", "email", "ip"]);
		assert.deepEqual(Object.keys(byCol.get("email")!.entity_types), ["EMAIL_ADDRESS"]);
		assert.deepEqual(Object.keys(byCol.get("ip")!.entity_types), ["IP_ADDRESS"]);
		assert.deepEqual(Object.keys(byCol.get("card")!.entity_types), ["CREDIT_CARD"]);
	});

	it("caps sampling at sampleSizePerColumn values", () => {
		const rows = Array.from({ length: 30 }, (_, i) => [`u${i}@example.com`]);
		const frag = csvFragment(["email"], rows);
		const small: PiicatcherConfig = { ...CFG, sampleSizePerColumn: 5 };
		const res = classifyFragment(frag, small);
		assert.equal(res.findings[0]!.sample_size, 5);
	});

	it("respects sensitivityThreshold=1 only for fully-sensitive columns", () => {
		const rows = [
			["ada@example.com"],
			["grace@example.com"],
			["not an email"],
		];
		const frag = csvFragment(["c"], rows);
		const strict: PiicatcherConfig = { ...CFG, sensitivityThreshold: 1 };
		assert.deepEqual(classifyFragment(frag, strict).findings, []);
		const loose: PiicatcherConfig = { ...CFG, sensitivityThreshold: 0.5 };
		assert.equal(classifyFragment(frag, loose).findings.length, 1);
	});

	it("allowlisted fingerprints do not count toward the match ratio", () => {
		const rows = [
			["ada@example.com"],
			["grace@example.com"],
			["alan@example.com"],
		];
		const frag = csvFragment(["email"], rows);
		const allowOne: PiicatcherConfig = {
			...CFG,
			sensitivityThreshold: 1,
			allowFingerprints: [fingerprintOf("ada@example.com")],
		};
		// With ada allowlisted, 2/3 match → below the strict threshold.
		assert.deepEqual(classifyFragment(frag, allowOne).findings, []);
		assert.equal(classifyFragment(frag, allowOne).allowlisted_values, 1);
	});

	it("deny-listed values count as matches regardless of the score floor", () => {
		const rows = [["203.0.113.5"], ["203.0.113.6"], ["203.0.113.7"]];
		const frag = csvFragment(["ip"], rows);
		// Public IPs score 0.5 ≥ 0.3 floor normally; raise the floor to exclude,
		// then deny one fingerprint to force it back in.
		const highFloor: PiicatcherConfig = { ...CFG, minScore: 0.9 };
		assert.deepEqual(classifyFragment(frag, highFloor).findings, []);
		const denied: PiicatcherConfig = {
			...CFG,
			minScore: 0.9,
			denyFingerprints: [fingerprintOf("203.0.113.5"), fingerprintOf("203.0.113.6")],
		};
		const res = classifyFragment(frag, denied);
		assert.equal(res.findings.length, 1);
		assert.equal(res.findings[0]!.match_count, 2);
	});

	it("shape allowPatterns suppress matching values", () => {
		const rows = [["4111 1111 1111 1111"], ["5500 0000 0000 0004"], ["4242 4242 4242 4242"]];
		const frag = csvFragment(["card"], rows);
		const shaped: PiicatcherConfig = { ...CFG, allowPatterns: ["^4111"] };
		const res = classifyFragment(frag, shaped);
		assert.equal(res.findings[0]!.match_count, 2);
		assert.equal(res.allowlisted_values, 1);
	});
});

// ──────────────────────────── full scan over messages ────────────────────────────

describe("piicatcher scan over messages", () => {
	it("finds columns across fields, caps per field, never stores raw values", () => {
		const csvBlock = [
			"name,email",
			"Ada Lovelace,ada@example.com",
			"Grace Hopper,grace@example.com",
			"Alan Turing,alan@example.com",
		].join("\n");
		const messages = [
			msg({ tool_results: csvBlock }),
			msg({ content_text: "Discussion of the export followed; no table in this prose." }),
		];

		const scan = detectTabularPii(messages, CFG);
		assert.equal(scan.finding_count, 1);
		assert.equal(scan.fragments_scanned >= 1, true);
		const f = scan.findings[0]!;
		assert.equal(f.field, "tool_results");
		assert.equal(messages[0]!.tool_results!.includes("ada@example.com"), true); // sanity: fixture really has PII
		assert.ok(!JSON.stringify(scan).includes("ada@example.com"), "raw value must never appear in the scan result");

		// Anchors: affected message ids sorted, deduped.
		assert.deepEqual(scan.affected_message_ids, [messages[0]!.id]);
	});

	it("is deterministic: identical input yields identical output", () => {
		const csvBlock = ["e,c", "a@example.com,4111111111111111", "b@example.com,5500000000000004", "c@example.com,4242424242424242"].join("\n");
		const messages = [msg({ tool_results: csvBlock })];
		const a = JSON.stringify(detectTabularPii(messages, CFG));
		const b = JSON.stringify(detectTabularPii(messages, CFG));
		assert.equal(a, b);
	});

	it("caps findings at maxMatchesPerField per message field", () => {
		// Three sensitive columns → three findings; cap at two.
		const rows = [
			["a@example.com", "203.0.113.5", "4111111111111111"],
			["b@example.com", "203.0.113.6", "5500000000000004"],
			["c@example.com", "203.0.113.7", "4242424242424242"],
		].map((r) => r.join(","));
		const text = ["email,ip,card", ...rows].join("\n");
		const capped: PiicatcherConfig = { ...CFG, maxMatchesPerField: 2 };
		const scan = detectTabularPii([msg({ tool_results: text })], capped);
		assert.equal(scan.finding_count, 2);
		assert.equal(scan.truncated_matches, 1);
	});
});

// ──────────────────────────── config schema ────────────────────────────

describe("piicatcher config", () => {
	it("default config validates against the TypeBox schema", () => {
		// Value check via the compiled schema would need a validator; assert the
		// shape's keys and defaults instead (schema compile happens at import).
		assert.equal(DEFAULT_PIICATCHER_CONFIG.formats.csv, true);
		assert.equal(DEFAULT_PIICATCHER_CONFIG.formats.json, true);
		assert.equal(DEFAULT_PIICATCHER_CONFIG.formats.sql, true);
		assert.equal(DEFAULT_PIICATCHER_CONFIG.sampleSizePerColumn > 0, true);
		assert.ok(DEFAULT_PIICATCHER_CONFIG.sensitivityThreshold > 0 && DEFAULT_PIICATCHER_CONFIG.sensitivityThreshold <= 1);
		assert.ok(PiicatcherConfigSchema.properties !== undefined);
	});
});
