/**
 * Unit tests for the DataProfiler-method tabular file PII detector. Pure
 * functions, no deps, no mocks.
 *
 * Coverage: file-touch detection and content pairing (structured read/write
 * tools, bash paths, redirects, binary skipping, ambiguous results),
 * header-label inference (label fires on "customer_email" even with sparse
 * values; downgrades when values contradict), value-distribution scoring,
 * verdict combination, and the full scan over messages.
 *
 * All fixture values are synthetic: example.com addresses, the public Luhn
 * test card, RFC 5737 TEST-NET addresses, 555-01xx fictional numbers.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectFileTouches } from "../../src/analyze/analyzers/dataprofiler/file-touches.js";
import { parseTable, profileTable } from "../../src/analyze/analyzers/dataprofiler/profile.js";
import { inferHeaderLabels } from "../../src/analyze/analyzers/dataprofiler/headers.js";
import { profileSessionFiles } from "../../src/analyze/analyzers/dataprofiler/detectors.js";
import {
	DEFAULT_DATAPROFILER_CONFIG,
	type DataprofilerConfig,
} from "../../src/analyze/analyzers/dataprofiler/config.js";
import { fingerprintOf } from "../../src/analyze/analyzers/secret-scanner.js";
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

const CFG: DataprofilerConfig = { ...DEFAULT_DATAPROFILER_CONFIG };

const CUSTOMERS_CSV = [
	"name,email,phone",
	"Ada Lovelace,ada@example.com,+1 415 555 0132",
	"Grace Hopper,grace@example.com,+1 415 555 0133",
	"Alan Turing,alan@example.com,+1 415 555 0134",
].join("\n");

/** A read-tool call row plus its paired result row carrying `content`. */
function readPair(callId: string, path: string, content: string): MessageRow[] {
	return [
		msg({
			role: "assistant",
			tool_calls: JSON.stringify([{ id: callId, name: "read", arguments: { file_path: path } }]),
		}),
		msg({
			role: "toolResult",
			content_text: content,
			tool_results: JSON.stringify([{ toolCallId: callId, toolName: "read", isError: false, textLength: content.length }]),
		}),
	];
}

// ──────────────────────────── file-touch detection ────────────────────────────

describe("dataprofiler file-touch detection", () => {
	it("pairs a read tool call with its result content by tool-call id", () => {
		const messages = readPair("call-1", "/data/customers.csv", CUSTOMERS_CSV);
		const scan = detectFileTouches(messages, CFG);
		assert.equal(scan.touches.length, 1);
		const t = scan.touches[0]!;
		assert.equal(t.path, "/data/customers.csv");
		assert.equal(t.direction, "read");
		assert.equal(t.format, "csv");
		assert.equal(t.callId, "call-1");
		assert.equal(t.callMessageId, messages[0]!.id);
		assert.equal(t.resultMessageId, messages[1]!.id);
		assert.equal(t.content, CUSTOMERS_CSV);
	});

	it("captures a write tool's content from its arguments", () => {
		const messages = [
			msg({
				role: "assistant",
				tool_calls: JSON.stringify([
					{ id: "call-w", name: "write", arguments: { file_path: "/tmp/export.csv", content: CUSTOMERS_CSV } },
				]),
			}),
			msg({
				role: "toolResult",
				content_text: "File created successfully",
				tool_results: JSON.stringify([{ toolCallId: "call-w", toolName: "write", isError: false, textLength: 24 }]),
			}),
		];
		const scan = detectFileTouches(messages, CFG);
		assert.equal(scan.touches.length, 1);
		const t = scan.touches[0]!;
		assert.equal(t.direction, "write");
		assert.equal(t.content, CUSTOMERS_CSV);
	});

	it("extracts bash cat targets as reads and redirect targets as writes", () => {
		const messages = [
			msg({
				role: "assistant",
				tool_calls: JSON.stringify([
					{ id: "call-b", name: "bash", arguments: { command: "cat /data/in.csv | sort > /data/out.csv" } },
				]),
			}),
		];
		const scan = detectFileTouches(messages, CFG);
		const byDir = new Map(scan.touches.map((t) => [t.direction, t]));
		assert.equal(byDir.get("read")!.path, "/data/in.csv");
		assert.equal(byDir.get("write")!.path, "/data/out.csv");
		// Neither has a paired result on this call-only message.
		assert.equal(byDir.get("read")!.content, null);
		assert.equal(byDir.get("write")!.content, null);
	});

	it("claims no content when the result row joins several results", () => {
		const messages = [
			msg({
				role: "assistant",
				tool_calls: JSON.stringify([
					{ id: "call-1", name: "read", arguments: { file_path: "/a.csv" } },
					{ id: "call-2", name: "read", arguments: { file_path: "/b.csv" } },
				]),
			}),
			msg({
				role: "toolResult",
				content_text: `${CUSTOMERS_CSV}\n${CUSTOMERS_CSV}`,
				tool_results: JSON.stringify([
					{ toolCallId: "call-1", toolName: "read", isError: false, textLength: 10 },
					{ toolCallId: "call-2", toolName: "read", isError: false, textLength: 10 },
				]),
			}),
		];
		const scan = detectFileTouches(messages, CFG);
		assert.equal(scan.touches.length, 2);
		for (const t of scan.touches) assert.equal(t.content, null);
	});

	it("claims no content from an errored result", () => {
		const messages = [
			msg({
				role: "assistant",
				tool_calls: JSON.stringify([{ id: "call-e", name: "read", arguments: { file_path: "/a.csv" } }]),
			}),
			msg({
				role: "toolResult",
				content_text: "ENOENT",
				tool_results: JSON.stringify([{ toolCallId: "call-e", toolName: "read", isError: true, textLength: 6 }]),
			}),
		];
		const scan = detectFileTouches(messages, CFG);
		assert.equal(scan.touches[0]!.content, null);
	});

	it("skips binary tabular formats and counts them", () => {
		const messages = [
			msg({
				role: "assistant",
				tool_calls: JSON.stringify([{ id: "call-p", name: "read", arguments: { file_path: "/d/users.parquet" } }]),
			}),
		];
		const scan = detectFileTouches(messages, CFG);
		assert.deepEqual(scan.touches, []);
		assert.equal(scan.skippedBinary, 1);
	});

	it("honours the format toggles", () => {
		const noJson: DataprofilerConfig = { ...CFG, formats: { csv: true, tsv: true, json: false } };
		const messages = [
			msg({
				role: "assistant",
				tool_calls: JSON.stringify([{ id: "call-j", name: "read", arguments: { file_path: "/d/users.json" } }]),
			}),
		];
		const scan = detectFileTouches(messages, noJson);
		assert.deepEqual(scan.touches, []);
		assert.equal(scan.skippedOtherExtension, 1);
	});

	it("recognises .tsv, .tab, .jsonl extensions with their formats", () => {
		for (const [path, format] of [
			["/a.tsv", "tsv"],
			["/b.tab", "tsv"],
			["/c.jsonl", "json"],
			["/d.csv", "csv"],
		] as const) {
			const messages = [
				msg({
					role: "assistant",
					tool_calls: JSON.stringify([{ id: "call-x", name: "read", arguments: { file_path: path } }]),
				}),
			];
			const scan = detectFileTouches(messages, CFG);
			assert.equal(scan.touches[0]!.format, format, path);
		}
	});
});

// ──────────────────────────── table parsing ────────────────────────────

describe("dataprofiler table parsing", () => {
	it("parses a CSV with header inference and quoted cells", () => {
		const table = parseTable(CUSTOMERS_CSV, "csv");
		assert.ok(table);
		assert.deepEqual(table!.header, ["name", "email", "phone"]);
		assert.equal(table!.rows.length, 3);
		assert.deepEqual(table!.rows[0], ["Ada Lovelace", "ada@example.com", "+1 415 555 0132"]);
	});

	it("parses TSV on tabs", () => {
		const table = parseTable("user\tip\nada\t203.0.113.5\ngrace\t203.0.113.6", "tsv");
		assert.ok(table);
		assert.deepEqual(table!.header, ["user", "ip"]);
		assert.deepEqual(table!.rows[1], ["grace", "203.0.113.6"]);
	});

	it("parses a JSON array of records and NDJSON", () => {
		const table = parseTable('[{"email": "ada@example.com"}, {"email": "grace@example.com"}]', "json");
		assert.ok(table);
		assert.deepEqual(table!.header, ["email"]);
		assert.equal(table!.rows.length, 2);

		const nd = parseTable('{"email": "ada@example.com"}\n{"email": "grace@example.com"}', "json");
		assert.ok(nd);
		assert.deepEqual(nd!.header, ["email"]);
		assert.equal(nd!.rows.length, 2);
	});

	it("rejects content that does not parse as the claimed format", () => {
		assert.equal(parseTable("not a table at all, really", "csv"), null);
		assert.equal(parseTable("just one line", "csv"), null);
		assert.equal(parseTable('{"a": 1}', "json"), null); // not a record array
		assert.equal(parseTable("[1,2,3]", "json"), null);
	});

	it("names columns column_N when the first row is numeric data", () => {
		const table = parseTable("1,2\n3,4\n5,6", "csv");
		assert.ok(table);
		assert.deepEqual(table!.header, ["column_1", "column_2"]);
		assert.equal(table!.rows.length, 3);
	});
});

// ──────────────────────────── header-label inference ────────────────────────────

describe("dataprofiler header-label inference", () => {
	it("fires the email label on customer_email", () => {
		const fired = inferHeaderLabels("customer_email", CFG.headerLabels.groups);
		assert.equal(fired.length, 1);
		assert.equal(fired[0]!.group, "email");
		assert.deepEqual(fired[0]!.impliedEntities, ["EMAIL_ADDRESS"]);
	});

	it("fires case-insensitively and on common variants", () => {
		for (const cell of ["Email", "E_MAIL", "email_address", "contact_phone", "SSN", "date_of_birth", "Account ID", "IBAN"]) {
			const fired = inferHeaderLabels(cell, CFG.headerLabels.groups);
			assert.ok(fired.length >= 1, `${cell} must fire a label`);
		}
	});

	it("does not fire on ordinary column names", () => {
		for (const cell of ["id", "created_at", "quantity", "total_amount", "status"]) {
			assert.deepEqual(inferHeaderLabels(cell, CFG.headerLabels.groups), [], cell);
		}
	});

	it("honours the per-group toggles", () => {
		const groups = { ...CFG.headerLabels.groups, email: false };
		assert.deepEqual(inferHeaderLabels("customer_email", groups), []);
	});

	it("name, dob, and salary carry no implied recognizer entities", () => {
		for (const cell of ["first_name", "dob", "salary"]) {
			const fired = inferHeaderLabels(cell, CFG.headerLabels.groups);
			assert.equal(fired[0]!.impliedEntities.length, 0, cell);
		}
	});
});

// ──────────────────────────── verdict combination ────────────────────────────

describe("dataprofiler column verdicts", () => {
	it("label + supporting values confirms", () => {
		const table = parseTable(CUSTOMERS_CSV, "csv")!;
		const res = profileTable(table, CFG);
		const email = res.sensitive.find((c) => c.column_name === "email")!;
		assert.ok(email);
		assert.equal(email.verdict, "confirmed");
		assert.equal(email.value_ratio, 1);
		assert.deepEqual(email.labels, ["email"]);
		assert.deepEqual(Object.keys(email.entity_types), ["EMAIL_ADDRESS"]);
		// score = 0.6·1 + 0.4·1
		assert.ok(Math.abs(email.score - 1) < 1e-9);
	});

	it("label fires on sparse values (downgraded to label-only)", () => {
		// customer_email header, but only one email among ten mostly-blank cells.
		const rows = [
			["ada@example.com", "x"],
			["", "y"],
			["", "z"],
			["", "w"],
			["", "v"],
			["", "u"],
			["", "t"],
			["", "s"],
			["", "r"],
			["", "q"],
		];
		const table = { header: ["customer_email", "note"], rows };
		const res = profileTable(table, CFG);
		assert.equal(res.sensitive.length, 1);
		const col = res.sensitive[0]!;
		assert.deepEqual(col.labels, ["email"]);
		assert.equal(col.verdict, "label-only");
		assert.ok(col.value_ratio < CFG.valueThreshold);
		// score = 0.6·0.1 + 0.4·1
		assert.ok(Math.abs(col.score - (0.6 * 0.1 + 0.4)) < 1e-9);
		assert.equal(res.label_only_columns, 1);
	});

	it("downgrades when values contradict the label", () => {
		// Header says email; every value is an ordinary name — no shape support.
		const rows = [
			["Ada Lovelace", "1"],
			["Grace Hopper", "2"],
			["Alan Turing", "3"],
		];
		const table = { header: ["email", "id"], rows };
		const res = profileTable(table, CFG);
		assert.equal(res.sensitive.length, 1);
		const col = res.sensitive[0]!;
		assert.equal(col.verdict, "label-only");
		assert.equal(col.match_count, 0);
		assert.equal(col.value_ratio, 0);
		assert.equal(col.redacted_preview, "(no shape evidence)");
		assert.equal(col.fingerprint, fingerprintOf("column:email"));
	});

	it("an unlabelled email column flags on distribution alone", () => {
		const rows = [
			["ada@example.com", "1"],
			["grace@example.com", "2"],
			["alan@example.com", "3"],
		];
		const table = { header: ["column_1", "column_2"], rows };
		const res = profileTable(table, CFG);
		assert.equal(res.sensitive.length, 1);
		assert.equal(res.sensitive[0]!.verdict, "values-only");
		assert.deepEqual(res.sensitive[0]!.labels, []);
	});

	it("an unlabelled column below the threshold stays below", () => {
		const rows = [
			["ada@example.com", ""],
			["plain text", ""],
			["more text", ""],
			["even more", ""],
		];
		const res = profileTable({ header: ["a", "b"], rows }, CFG);
		assert.deepEqual(res.sensitive, []);
		// Both columns: the sparse email one and the all-empty one.
		assert.equal(res.below_threshold_columns, 2);
	});

	it("a labelled column only accepts its implied shapes", () => {
		// Header says phone; values are emails → no support, label-only.
		const rows = [
			["ada@example.com"],
			["grace@example.com"],
			["alan@example.com"],
		];
		const res = profileTable({ header: ["phone"], rows }, CFG);
		assert.equal(res.sensitive[0]!.verdict, "label-only");
		assert.equal(res.sensitive[0]!.match_count, 0);
	});

	it("a label with no deterministic recognizer can only be label-only", () => {
		// Salary values are bare numbers; nothing deterministic can support it.
		const rows = [["120000"], ["130000"], ["140000"]];
		const res = profileTable({ header: ["salary"], rows }, CFG);
		assert.equal(res.sensitive.length, 1);
		assert.equal(res.sensitive[0]!.verdict, "label-only");
	});

	it("disabling headerLabels leaves pure distribution mode", () => {
		const rows = [["Ada Lovelace", "1"], ["Grace Hopper", "2"], ["Alan Turing", "3"]];
		const cfg: DataprofilerConfig = {
			...CFG,
			headerLabels: { ...CFG.headerLabels, enabled: false },
		};
		const res = profileTable({ header: ["email", "id"], rows }, cfg);
		assert.deepEqual(res.sensitive, []);
	});

	it("valueScoreWeight shifts the combined score", () => {
		const rows = [["ada@example.com"], ["grace@example.com"], ["alan@example.com"]];
		const table = { header: ["email"], rows };
		const heavy: DataprofilerConfig = { ...CFG, valueScoreWeight: 1 };
		assert.ok(Math.abs(profileTable(table, heavy).sensitive[0]!.score - 1) < 1e-9);
		const light: DataprofilerConfig = { ...CFG, valueScoreWeight: 0 };
		assert.equal(profileTable(table, light).sensitive[0]!.score, 1); // label still 1
	});

	it("caps sampling at sampleSize values (empties in the denominator)", () => {
		const rows = Array.from({ length: 30 }, (_, i) => [i < 2 ? `u${i}@example.com` : ""]);
		const res = profileTable({ header: ["email"], rows }, { ...CFG, sampleSize: 10 });
		assert.equal(res.sensitive[0]!.sample_size, 10);
		assert.equal(res.sensitive[0]!.match_count, 2);
		assert.equal(res.sensitive[0]!.verdict, "label-only");
	});

	it("allowlisted fingerprints do not count toward the ratio; denied bypass the floor", () => {
		const rows = [["4111 1111 1111 1111"], ["5500 0000 0000 0004"], ["4242 4242 4242 4242"]];
		const table = { header: ["card"], rows };
		const allow: DataprofilerConfig = {
			...CFG,
			allowFingerprints: [fingerprintOf("4111 1111 1111 1111")],
		};
		const allowRes = profileTable(table, allow);
		assert.equal(allowRes.sensitive[0]!.match_count, 2);
		assert.equal(allowRes.allowlisted_values, 1);

		const deny: DataprofilerConfig = {
			...CFG,
			minScore: 0.99,
			denyFingerprints: [fingerprintOf("ada@example.com")],
		};
		// Emails score 0.5, so the 0.99 floor excludes them all; denying one
		// fingerprint forces exactly that value back into the match count.
		const emailRows = [["ada@example.com"], ["grace@example.com"], ["alan@example.com"]];
		const denyRes = profileTable({ header: ["contact"], rows: emailRows }, deny);
		assert.deepEqual(denyRes.sensitive, []); // unlabelled: 1/3 stays below threshold

		const denyLabelled = profileTable({ header: ["email"], rows: emailRows }, deny);
		assert.equal(denyLabelled.sensitive[0]!.match_count, 1);
		assert.equal(denyLabelled.sensitive[0]!.verdict, "label-only");
	});

	it("shape allowPatterns suppress matching values", () => {
		const rows = [["4111 1111 1111 1111"], ["5500 0000 0000 0004"], ["4242 4242 4242 4242"]];
		const res = profileTable({ header: ["card"], rows }, { ...CFG, allowPatterns: ["^4111"] });
		assert.equal(res.sensitive[0]!.match_count, 2);
		assert.equal(res.allowlisted_values, 1);
	});
});

// ──────────────────────────── full scan over messages ────────────────────────────

describe("dataprofiler scan over messages", () => {
	it("produces file-level findings anchored to the touching message", () => {
		const messages = [
			msg({ role: "user", content_text: "Please review the customer export." }),
			...readPair("call-1", "/data/customers.csv", CUSTOMERS_CSV),
			msg({ role: "assistant", content_text: "Done; nothing else to report." }),
		];

		const scan = profileSessionFiles(messages, CFG);
		assert.equal(scan.finding_count, 1);
		const f = scan.findings[0]!;
		assert.equal(f.path, "/data/customers.csv");
		assert.equal(f.direction, "read");
		assert.equal(f.message_id, messages[1]!.id);
		assert.equal(f.result_message_id, messages[2]!.id);
		assert.equal(f.severity, "high");
		// name fires label-only (no deterministic recognizer); email and phone
		// confirm against their implied shapes.
		const byName = new Map(f.sensitive_columns.map((c) => [c.column_name, c]));
		assert.deepEqual([...byName.keys()].sort(), ["email", "name", "phone"]);
		assert.equal(byName.get("name")!.verdict, "label-only");
		assert.equal(byName.get("email")!.verdict, "confirmed");
		assert.equal(byName.get("phone")!.verdict, "confirmed");
		assert.equal(scan.files_touched, 1);
		assert.equal(scan.files_profiled, 1);
		assert.deepEqual(scan.affected_message_ids, [messages[1]!.id]);
	});

	it("never stores raw PII or file content in the scan result", () => {
		const messages = [...readPair("call-1", "/data/customers.csv", CUSTOMERS_CSV)];
		const scan = profileSessionFiles(messages, CFG);
		const serialised = JSON.stringify(scan);
		for (const value of ["ada@example.com", "Ada Lovelace", "+1 415 555 0132", CUSTOMERS_CSV]) {
			assert.ok(!serialised.includes(value), `raw value must never appear: ${value}`);
		}
		// Fingerprints are derived identically to the shared engine.
		const email = scan.findings[0]!.sensitive_columns.find((c) => c.column_name === "email")!;
		assert.equal(email.fingerprint, fingerprintOf("ada@example.com"));
	});

	it("is deterministic: identical input yields identical output", () => {
		const messages = [...readPair("call-1", "/data/customers.csv", CUSTOMERS_CSV)];
		const a = JSON.stringify(profileSessionFiles(messages, CFG));
		const b = JSON.stringify(profileSessionFiles(messages, CFG));
		assert.equal(a, b);
	});

	it("caps findings at maxMatchesPerField per message", () => {
		const command = "cat a.csv b.csv c.csv";
		const messages = [
			msg({
				role: "assistant",
				tool_calls: JSON.stringify([{ id: "call-1", name: "bash", arguments: { command } }]),
			}),
			msg({
				role: "toolResult",
				content_text: CUSTOMERS_CSV,
				tool_results: JSON.stringify([{ toolCallId: "call-1", toolName: "bash", isError: false, textLength: 10 }]),
			}),
		];
		// One bash result row, three touches — the single-result rule attributes
		// the content to each read of that call. Cap at two findings.
		const capped: DataprofilerConfig = { ...CFG, maxMatchesPerField: 2 };
		const scan = profileSessionFiles(messages, capped);
		assert.equal(scan.finding_count, 2);
		assert.equal(scan.truncated_matches, 1);
	});

	it("counts touches without content instead of profiling them", () => {
		const messages = [
			msg({
				role: "assistant",
				tool_calls: JSON.stringify([{ id: "call-1", name: "bash", arguments: { command: "wc -l users.csv" } }]),
			}),
		];
		const scan = profileSessionFiles(messages, CFG);
		assert.equal(scan.finding_count, 0);
		assert.equal(scan.files_touched, 1);
		assert.equal(scan.touches_without_content, 1);
	});
});

// ──────────────────────────── config schema ────────────────────────────

describe("dataprofiler config", () => {
	it("default config validates against the TypeBox schema", () => {
		assert.equal(DEFAULT_DATAPROFILER_CONFIG.formats.csv, true);
		assert.equal(DEFAULT_DATAPROFILER_CONFIG.formats.tsv, true);
		assert.equal(DEFAULT_DATAPROFILER_CONFIG.formats.json, true);
		assert.equal(DEFAULT_DATAPROFILER_CONFIG.headerLabels.enabled, true);
		assert.ok(DEFAULT_DATAPROFILER_CONFIG.valueScoreWeight > 0 && DEFAULT_DATAPROFILER_CONFIG.valueScoreWeight < 1);
		assert.ok(DEFAULT_DATAPROFILER_CONFIG.valueThreshold > 0 && DEFAULT_DATAPROFILER_CONFIG.valueThreshold <= 1);
		assert.ok(DEFAULT_DATAPROFILER_CONFIG.sampleSize > 0);
		assert.ok(DEFAULT_DATAPROFILER_CONFIG.minScore > 0 && DEFAULT_DATAPROFILER_CONFIG.minScore <= 1);
	});
});
